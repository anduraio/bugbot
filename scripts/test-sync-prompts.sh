#!/usr/bin/env bash
#
# Offline test for scripts/sync-prompts.sh. Copies the script and prompts into
# a throwaway repo, points PSTACK_DIR at a fake tree and checks:
#   - headers, table hashes and both prose version lines move to 9.9.9
#   - every prompt file and both READMEs are mode 644, including a no-op run
#     that started from mode 600
#   - a missing or unreadable source, or a missing README row, exits non-zero
#     and leaves prompts/ byte-for-byte untouched (preflight before writes)
# It never reads a real pstack tree, the network, or anything outside a temp
# directory.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sync_script="$repo_root/scripts/sync-prompts.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/sync-prompts-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT

sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

sha_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

tree_hash() {
  find "$1" -type f | sort | while IFS= read -r file; do
    printf '%s  %s\n' "$(sha "$file")" "$file"
  done
}

copy_repo() {
  local target="$1"
  mkdir -p "$target"
  cp -R "$repo_root/scripts" "$target/scripts"
  cp -R "$repo_root/prompts" "$target/prompts"
  cp "$repo_root/README.md" "$target/README.md"
}

fake="$work/pstack"
mkdir -p "$fake"
printf '{\n  "name": "fake-pstack",\n  "version": "9.9.9"\n}\n' > "$fake/plugin.json"

while IFS= read -r entry; do
  source_rel="${entry%%:*}"
  mkdir -p "$fake/$(dirname "$source_rel")"
  printf 'fake pstack body for %s\n' "$source_rel" > "$fake/$source_rel"
done < <(sed -n '/^files=(/,/^)/p' "$sync_script" | sed -n 's/^  "\(.*\)"$/\1/p')

copy_repo "$work/repo"

echo "== first run (fake pstack 9.9.9) =="
PSTACK_DIR="$fake" "$work/repo/scripts/sync-prompts.sh"

echo "== version lines =="
grep -F 'Source: pstack **9.9.9**' "$work/repo/prompts/README.md"
grep -F 'They are vendored from pstack 9.9.9, MIT licensed' "$work/repo/README.md"

echo "== headers, table hashes and modes =="
while IFS= read -r entry; do
  dest_rel="${entry#*:}"
  file="$work/repo/prompts/$dest_rel"
  header_hash="$(sed -n '1s/.*sha256 \([0-9a-f]\{64\}\).*/\1/p' "$file")"
  body_hash="$(tail -n +2 "$file" | sha_stdin)"
  row_hash="$(grep -F "| \`prompts/$dest_rel\` |" "$work/repo/prompts/README.md" | sed -E 's/.*`([0-9a-f]{64})`.*/\1/')"

  test "$(sed -n '1p' "$file")" != ""
  grep -Fq 'pstack version 9.9.9' "$file"
  test "$header_hash" = "$body_hash"
  test "$row_hash" = "$header_hash"
  test "$(file_mode "$file")" = "644"
done < <(sed -n '/^files=(/,/^)/p' "$sync_script" | sed -n 's/^  "\(.*\)"$/\1/p')

test "$(file_mode "$work/repo/prompts/README.md")" = "644"
test "$(file_mode "$work/repo/README.md")" = "644"
echo "all headers, table rows and modes are correct"

echo "== every destination file is mode 644 =="
while IFS= read -r entry; do
  dest_rel="${entry#*:}"
  test "$(file_mode "$work/repo/prompts/$dest_rel")" = "644"
done < <(sed -n '/^files=(/,/^)/p' "$sync_script" | sed -n 's/^  "\(.*\)"$/\1/p')
test "$(file_mode "$work/repo/prompts/README.md")" = "644"
test "$(file_mode "$work/repo/README.md")" = "644"
echo "all destination files are 644"

echo "== no-op run repairs 600 modes =="
while IFS= read -r entry; do
  dest_rel="${entry#*:}"
  chmod 600 "$work/repo/prompts/$dest_rel"
done < <(sed -n '/^files=(/,/^)/p' "$sync_script" | sed -n 's/^  "\(.*\)"$/\1/p')
chmod 600 "$work/repo/prompts/README.md" "$work/repo/README.md"
noop_output="$(PSTACK_DIR="$fake" "$work/repo/scripts/sync-prompts.sh" 2>&1)"
printf '%s\n' "$noop_output"
printf '%s\n' "$noop_output" | grep -Fq "prompts/ already up to date"
while IFS= read -r entry; do
  dest_rel="${entry#*:}"
  test "$(file_mode "$work/repo/prompts/$dest_rel")" = "644"
done < <(sed -n '/^files=(/,/^)/p' "$sync_script" | sed -n 's/^  "\(.*\)"$/\1/p')
test "$(file_mode "$work/repo/prompts/README.md")" = "644"
test "$(file_mode "$work/repo/README.md")" = "644"
echo "a no-op run restores every destination mode to 644"

echo "== unreadable source leaves prompts/ untouched =="
copy_repo "$work/repo3"
chmod 000 "$fake/skills/blast-radius/SKILL.md"
before="$(tree_hash "$work/repo3/prompts")"
set +e
unreadable_output="$(PSTACK_DIR="$fake" "$work/repo3/scripts/sync-prompts.sh" 2>&1)"
unreadable_status=$?
set -e
chmod 644 "$fake/skills/blast-radius/SKILL.md"
after="$(tree_hash "$work/repo3/prompts")"
printf '%s\n' "$unreadable_output"
echo "exit=$unreadable_status"
test "$unreadable_status" -ne 0
printf '%s\n' "$unreadable_output" | grep -Fq "unreadable pstack source"
test "$before" = "$after"
echo "prompts/ unchanged after the unreadable-source failure"

echo "== missing source leaves prompts/ untouched =="
before="$(tree_hash "$work/repo/prompts")"
rm -f "$fake/skills/interrogate/references/rubric.md"
set +e
missing_source_output="$(PSTACK_DIR="$fake" "$work/repo/scripts/sync-prompts.sh" 2>&1)"
missing_source_status=$?
set -e
after="$(tree_hash "$work/repo/prompts")"
printf '%s\n' "$missing_source_output"
echo "exit=$missing_source_status"
test "$missing_source_status" -ne 0
test "$before" = "$after"
echo "prompts/ unchanged after the missing-source failure"

echo "== missing README row leaves prompts/ untouched =="
printf 'fake pstack body for %s\n' \
  "skills/interrogate/references/rubric.md" > "$fake/skills/interrogate/references/rubric.md"
copy_repo "$work/repo2"
grep -vF '| `prompts/bugbot-triage.md` |' \
  "$work/repo2/prompts/README.md" > "$work/readme2"
mv "$work/readme2" "$work/repo2/prompts/README.md"
before="$(tree_hash "$work/repo2/prompts")"
set +e
missing_row_output="$(PSTACK_DIR="$fake" "$work/repo2/scripts/sync-prompts.sh" 2>&1)"
missing_row_status=$?
set -e
after="$(tree_hash "$work/repo2/prompts")"
printf '%s\n' "$missing_row_output"
echo "exit=$missing_row_status"
test "$missing_row_status" -ne 0
test "$before" = "$after"
echo "prompts/ unchanged after the missing-row failure"

echo "== a version with sed-special characters is inserted literally =="
special="$work/pstack-special"
cp -R "$fake" "$special"
printf '{\n  "name": "fake-pstack",\n  "version": "1.0/2&3"\n}\n' > "$special/plugin.json"
copy_repo "$work/repo4"
PSTACK_DIR="$special" "$work/repo4/scripts/sync-prompts.sh" >/dev/null
grep -F 'Source: pstack **1.0/2&3**' "$work/repo4/prompts/README.md"
grep -F 'They are vendored from pstack 1.0/2&3, MIT licensed' "$work/repo4/README.md"
echo "a version with / and & is written literally"

echo "sync-prompts test passed"
