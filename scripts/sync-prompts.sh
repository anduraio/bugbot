#!/usr/bin/env bash
#
# Refresh the pstack texts vendored under prompts/ from a local pstack tree.
# Manual only: CI never runs this, it never commits, and it makes no network
# calls. Run it after updating pstack, review the diff, then commit prompts/.
set -euo pipefail

pstack_dir="${PSTACK_DIR:-$HOME/.pstack}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prompts_dir="$repo_root/prompts"

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

# Keep the hash cell in prompts/README.md in step with the header. The row is
# "| `prompts/<dest>` | `pstack source` | role | `<sha256>` |"; the role may
# contain backticks, so rebuild every backticked cell and replace the last one.
readme_changed=0
update_readme_hash() {
  local dest_rel="$1"
  local source_sha="$2"
  local readme="$prompts_dir/README.md"

  if [ ! -f "$readme" ]; then
    echo "sync-prompts: prompts/README.md is missing" >&2
    exit 1
  fi

  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/sync-prompts-readme.XXXXXX")"

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
  ' "$readme" > "$tmp"; then
    echo "sync-prompts: no table row for prompts/$dest_rel in prompts/README.md" >&2
    rm -f "$tmp"
    exit 1
  fi

  if cmp -s "$tmp" "$readme"; then
    rm -f "$tmp"
  else
    mv "$tmp" "$readme"
    readme_changed=1
  fi
}

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

changed=()
for file in "${files[@]}"; do
  source_rel="${file%%:*}"
  dest_rel="${file#*:}"
  source_path="$pstack_dir/$source_rel"
  dest_path="$prompts_dir/$dest_rel"

  if [ ! -f "$source_path" ]; then
    echo "sync-prompts: missing pstack source: $source_path" >&2
    exit 1
  fi

  source_sha="$(sha256 "$source_path")"
  header="<!-- vendored from pstack $source_rel | pstack version $plugin_version | sha256 $source_sha | MIT (c) 2026 Lauren Tan | refresh with scripts/sync-prompts.sh -->"

  tmp="$(mktemp "${TMPDIR:-/tmp}/sync-prompts.XXXXXX")"
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

  update_readme_hash "$dest_rel" "$source_sha"
done

if [ "$readme_changed" -eq 1 ]; then
  changed+=("prompts/README.md")
fi

if [ "${#changed[@]}" -eq 0 ]; then
  echo "prompts/ already up to date (pstack $plugin_version)"
else
  printf 'updated %s\n' "${changed[@]}"
  echo "${#changed[@]} file(s) updated from pstack $plugin_version"
fi
