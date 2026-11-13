#!/usr/bin/env bash
# push-rebased.sh <rebase.tsv> — run inside a clone of the fork; needs FORK and TOKEN
# (FALLBACK_TOKEN optional, see fork-token.sh). Force-pushes each `rebased` row's
# refs/rebased/<branch> to <branch>, leased on the sha the round started from, so a
# branch someone moved meanwhile is never overwritten.
# Rows: PR, branch, status, old sha, new sha (the `integration rebase` format).
set -euo pipefail
# shellcheck source=fork-token.sh
. "$(dirname "$0")/fork-token.sh"
tsv="${1:?usage: push-rebased.sh <rebase.tsv>}"
[ -s "$tsv" ] || exit 0
while IFS=$'\t' read -r num branch status old new; do
	[ "$status" = rebased ] || continue
	[ "$(git rev-parse "refs/rebased/$branch")" = "$new" ] || { echo "push-rebased: refs/rebased/$branch is not $new" >&2; exit 1; }
	fork_write fork_push -q --force-with-lease="refs/heads/$branch:$old" "refs/rebased/$branch:refs/heads/$branch"
	echo "push-rebased: PR $num $branch -> ${new:0:10}"
done < "$tsv"
