#!/bin/sh
# SEC-7 (TER-726) — security exploit golden set, run as an ISOLATED CI step.
#
# Why isolated instead of relying on the blanket `bun test tests/unit/` step:
# these files pass fine inside that glob (verified), but the glob's overall
# exit code is entangled with ~2500 OTHER backend tests, some of which have
# pre-existing, unrelated failures (handler-signature drift, tracked
# separately). When that happens, the broad step fails and any step *after*
# it in ci.yml is skipped — so a security regression test could pass, fail,
# or never even run, and CI would report the same thing either way. Empirically
# confirmed on PR #420's first CI run: the golden-set assertions all passed,
# but the step position after "Run unit tests" meant they'd have been
# silently skipped had the golden set failed instead. An isolated step run
# BEFORE the broad suite gives these tests their own, undiluted verdict.
#
# Tolerant-by-design: SEC-1..6 ship as individual draft PRs to `dev`, merged
# independently and out of order (project decision, see TER-719 handoff). A
# target file that doesn't exist YET means "its SEC-N branch hasn't merged",
# not "the exploit test failed" — this script must not break CI for every
# other PR in that gap. Once a target exists, its test result is real and
# DOES fail the build. This mirrors the existing `prompt-regression` job's
# "informative until the dependency lands" pattern in ci.yml.
set -e

cd "$(dirname "$0")/.."

# path|label|kind — kind=mca targets need @teros/mca-sdk built first (no
# "bun"→src export condition in its package.json, unlike @teros/core/shared).
TARGETS="
packages/backend/tests/unit/install-authz-sec1.test.ts|SEC-1 (TER-720) — B-4 install-gate bypass|backend
packages/backend/tests/unit/access-idor-sec2.test.ts|SEC-2 (TER-721) — /api/files IDOR + channel.create BOLA|backend
mcas/mca.github/test/unit/clone-repo.test.ts|SEC-3 (TER-722) — command injection in mca.github clone-repo|mca
packages/backend/tests/unit/content-safety-media.test.ts|SEC-4a (TER-723) — SVG stored XSS|backend
mcas/mca.odoo/test/unit/odoo-client.test.ts|SEC-4b (TER-723) — SSRF in mca.odoo BASE_URL|mca
packages/backend/tests/unit/install-gate-invariant-sec7.test.ts|SEC-7 (TER-726) — install-gate structural invariant|backend
"

present_count=0
total_count=0
failed=0
need_mca_sdk=0

OLD_IFS=$IFS
IFS='
'
for line in $TARGETS; do
  [ -z "$line" ] && continue
  path=$(echo "$line" | cut -d'|' -f1)
  kind=$(echo "$line" | cut -d'|' -f3)
  [ -f "$path" ] && [ "$kind" = "mca" ] && need_mca_sdk=1
done
IFS=$OLD_IFS

if [ "$need_mca_sdk" -eq 1 ]; then
  echo "-- building @teros/mca-sdk (required by MCA-level golden-set tests) --"
  yarn workspace @teros/mca-sdk build
fi

echo "== SEC-7 security golden set =="

OLD_IFS=$IFS
IFS='
'
for line in $TARGETS; do
  [ -z "$line" ] && continue
  path=$(echo "$line" | cut -d'|' -f1)
  label=$(echo "$line" | cut -d'|' -f2)
  total_count=$((total_count + 1))
  if [ ! -f "$path" ]; then
    echo "PENDING  $label"
    echo "         $path not merged yet (its SEC-N branch is still a separate draft PR)"
    continue
  fi
  present_count=$((present_count + 1))
  echo "RUNNING  $label"
  if ! bun test "$path"; then
    failed=1
  fi
done
IFS=$OLD_IFS

echo "== summary: $present_count/$total_count golden-set files present =="
if [ "$present_count" -lt "$total_count" ]; then
  echo "   (green here is expected pre-merge — see header comment. Once all"
  echo "    SEC-N branches land on dev this becomes a real 100% gate.)"
fi

exit $failed
