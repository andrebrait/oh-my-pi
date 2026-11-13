#!/usr/bin/env bash
# commit-fixups.sh <fixups.patch> <message> — run in a checkout of fork-ci; needs FORK
# and TOKEN (FALLBACK_TOKEN optional, see fork-token.sh). Commits a stage's
# fixup/resolution changes to fork-ci so later rounds replay them without an agent.
# Refuses a patch that touches anything outside the fixups directory; a patch that
# no longer applies to fork-ci fails the job.
set -euo pipefail
# shellcheck source=fork-token.sh
. "$(dirname "$0")/fork-token.sh"
patch="${1:?usage: commit-fixups.sh <fixups.patch> <message>}"
[ -s "$patch" ] || { echo "commit-fixups: no fixup changes"; exit 0; }
dir=config/fixups/root--git--oh-my-pi/
git apply --index "$patch"
# Both sides of a rename count: --no-renames lists the deleted path too.
if outside="$(git diff --cached --name-only --no-renames | grep -v "^$dir")"; then
	echo "commit-fixups: refusing a patch that touches files outside $dir:" >&2
	printf "%s\n" "$outside" >&2
	exit 1
fi
git -c user.name="omp auto-integration" -c user.email="omp-auto@users.noreply.github.com" commit -q -m "$2"
fork_write fork_push -q HEAD:refs/heads/fork-ci
echo "commit-fixups: pushed $(git rev-parse --short HEAD) to fork-ci"
