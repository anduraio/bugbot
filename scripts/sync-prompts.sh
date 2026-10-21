#!/usr/bin/env bash
#
# Refresh the pstack texts vendored under prompts/ from a local pstack tree.
# Manual only: CI never runs this, it never commits, and it makes no network
# calls. Run it after updating pstack, review the diff, then commit prompts/.
#
# All sources and README rows are read and checked before the first write, so a
# missing or unreadable file leaves prompts/ untouched. Every destination file
# is chmod 644, including on a no-op run. Temp files are staged inside prompts/
# so the final mv is a same-filesystem rename.
set -euo pipefail

pstack_dir="${PSTACK_DIR:-$HOME/.pstack}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prompts_dir="$repo_root/prompts"
prompts_readme="$prompts_dir/README.md"
root_readme="$repo_root/README.md"

if [ ! -d "$pstack_dir" ]; then
  echo "sync-prompts: PSTACK_DIR not found: $pstack_dir" >&2
  exit 1
fi
pstack_dir="$(cd "$pstack_dir" && pwd)"

plugin_version="$(
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$pstack_dir/plugin.json" | head -n 1
)"
if [ -z "$plugin_version" ]; then
  echo "sync-prompts: could not read version from $pstack_dir/plugin.json" >&2
  exit 1
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Escape a value for a sed -E replacement: backslash, the `/` delimiter and the
# replacement-special `&` become literal. The version comes from plugin.json,
# so this is defence against a stray character, not trust in the file (R2-N4).
escape_sed_replacement() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//&/\\&}"
  value="${value//\//\\/}"
  printf '%s' "$value"
}
plugin_version_sed="$(escape_sed_replacement "$plugin_version")"

# Source path under PSTACK_DIR, then destination path under prompts/.
# Keep this list in step with PROMPT_FILES in src/prompts.ts.
files=(
  "skills/interrogate/SKILL.md:interrogate/SKILL.md"
  "skills/interrogate/references/reviewer-prompt.md:interrogate/references/reviewer-prompt.md"
  "skills/interrogate/references/rubric.md:interrogate/references/rubric.md"
  "skills/interrogate/references/code-quality-review.md:interrogate/references/code-quality-review.md"
  "skills/interrogate/references/lead-judgment.md:interrogate/references/lead-judgment.md"
  "skills/blast-radius/SKILL.md:blast-radius/SKILL.md"
  "skills/poteto-mode/references/bugbot-triage.md:bugbot-triage.md"
  "agents/comment-sicko.md:comment-sicko.md"
  "skills/typescript-best-practices/SKILL.md:typescript-best-practices/SKILL.md"
  "skills/typescript-best-practices/references/patterns.md:typescript-best-practices/references/patterns.md"
  "skills/principle-fix-root-causes/SKILL.md:principle-fix-root-causes/SKILL.md"
  "skills/principle-test-behavior-not-implementation/SKILL.md:principle-test-behavior-not-implementation/SKILL.md"
)

# Preflight: every source, every README row and both prose version lines must
# exist before anything is written.
if [ ! -f "$prompts_readme" ]; then
  echo "sync-prompts: prompts/README.md is missing" >&2
  exit 1
fi
if [ ! -f "$root_readme" ]; then
  echo "sync-prompts: README.md is missing" >&2
  exit 1
fi

for file in "${files[@]}"; do
  source_rel="${file%%:*}"
  source_path="$pstack_dir/$source_rel"
  if [ ! -f "$source_path" ]; then
    echo "sync-prompts: missing pstack source: $source_path" >&2
    exit 1
  fi
  if [ ! -r "$source_path" ] || ! sha256 "$source_path" >/dev/null; then
    echo "sync-prompts: unreadable pstack source: $source_path" >&2
    exit 1
  fi
done

for file in "${files[@]}"; do
  dest_rel="${file#*:}"
  if ! grep -Fq "| \`prompts/$dest_rel\` |" "$prompts_readme"; then
    echo "sync-prompts: no table row for prompts/$dest_rel in prompts/README.md" >&2
    exit 1
  fi
done

if ! grep -Eq 'Source: pstack \*\*[0-9A-Za-z._-]+\*\*' "$prompts_readme"; then
  echo "sync-prompts: no 'Source: pstack **<version>**' line in prompts/README.md" >&2
  exit 1
fi
if ! grep -Eq 'They are vendored from pstack [0-9A-Za-z._-]+,' "$root_readme"; then
  echo "sync-prompts: no 'They are vendored from pstack <version>' line in README.md" >&2
  exit 1
fi

# Stage every temp file next to its destination so mv is a rename, not a
# cross-filesystem copy. This is created only after all preflight reads pass.
# The EXIT trap removes it on normal exits and on signals it can trap. A
# SIGKILL (or power loss) cannot run a trap, so an empty
# prompts/.sync-prompts.XXXXXX directory may be left behind; that is accepted.
# It is inert, sits inside prompts/, and no preflight read touches it.
tmp_dir="$(mktemp -d "$prompts_dir/.sync-prompts.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

# Keep the hash cell in prompts/README.md in step with the header. The row is
# "| `prompts/<dest>` | `pstack source` | role | `<sha256>` |"; the role may
# contain backticks, so rebuild every backticked cell and replace the last one.
readme_changed=0
update_readme_hash() {
  local dest_rel="$1"
  local source_sha="$2"
  local tmp

  tmp="$tmp_dir/readme"

  if ! awk -v path="$dest_rel" -v hash="$source_sha" '
    BEGIN { prefix = "| `prompts/" path "` |"; found = 0 }
    index($0, prefix) == 1 {
      n = split($0, parts, "`")
      if (n >= 4) {
        out = parts[1]
        for (i = 2; i < n; i++) {
          if (i % 2 == 0) {
            out = out "`" (i == n - 1 ? hash : parts[i]) "`"
          } else {
            out = out parts[i]
          }
        }
        out = out parts[n]
        $0 = out
        found = 1
      }
    }
    { print }
    END { exit(found ? 0 : 3) }
  ' "$prompts_readme" > "$tmp"; then
    echo "sync-prompts: no table row for prompts/$dest_rel in prompts/README.md" >&2
    rm -f "$tmp"
    exit 1
  fi

  if cmp -s "$tmp" "$prompts_readme"; then
    rm -f "$tmp"
  else
    mv "$tmp" "$prompts_readme"
    chmod 644 "$prompts_readme"
    readme_changed=1
  fi
}

# Replace the pstack version in one prose line, via a sed expression. Returns
# 0 when the file changed, 1 when it was already current.
root_readme_changed=0
update_prose_version() {
  local file="$1"
  local expression="$2"
  local tmp

  tmp="$tmp_dir/version"
  sed -E "$expression" "$file" > "$tmp"

  if cmp -s "$tmp" "$file"; then
    rm -f "$tmp"
    return 1
  fi

  mv "$tmp" "$file"
  chmod 644 "$file"
  return 0
}

changed=()
for file in "${files[@]}"; do
  source_rel="${file%%:*}"
  dest_rel="${file#*:}"
  source_path="$pstack_dir/$source_rel"
  dest_path="$prompts_dir/$dest_rel"

  source_sha="$(sha256 "$source_path")"
  header="<!-- vendored from pstack $source_rel | pstack version $plugin_version | sha256 $source_sha | MIT (c) 2026 Lauren Tan | refresh with scripts/sync-prompts.sh -->"

  tmp="$tmp_dir/prompt"
  {
    printf '%s\n' "$header"
    cat "$source_path"
  } > "$tmp"

  if [ -f "$dest_path" ] && cmp -s "$tmp" "$dest_path"; then
    rm -f "$tmp"
  else
    mkdir -p "$(dirname "$dest_path")"
    mv "$tmp" "$dest_path"
    changed+=("prompts/$dest_rel")
  fi
  # Unconditional: a no-op run must also repair a 600 destination (N4).
  chmod 644 "$dest_path"

  update_readme_hash "$dest_rel" "$source_sha"
done

# N3: the prose version lines name the pstack version too, not just the table
# hashes. Keep prompts/README.md and the root README.md in step.
if update_prose_version \
  "$prompts_readme" \
  "s/(Source: pstack \\*\\*)[^*]+(\\*\\*)/\\1${plugin_version_sed}\\2/"; then
  readme_changed=1
fi
if update_prose_version \
  "$root_readme" \
  "s/(They are vendored from pstack )[^,]+(, MIT licensed)/\\1${plugin_version_sed}\\2/"; then
  root_readme_changed=1
fi

# Unconditional, including a fully no-op run.
chmod 644 "$prompts_readme" "$root_readme"

if [ "$readme_changed" -eq 1 ]; then
  changed+=("prompts/README.md")
fi
if [ "$root_readme_changed" -eq 1 ]; then
  changed+=("README.md")
fi

if [ "${#changed[@]}" -eq 0 ]; then
  echo "prompts/ already up to date (pstack $plugin_version)"
else
  printf 'updated %s\n' "${changed[@]}"
  echo "${#changed[@]} file(s) updated from pstack $plugin_version"
fi
