#!/usr/bin/env bash
# fork-guard.sh <fork-ci checkout> — disables every active workflow of
# $GITHUB_REPOSITORY whose file is not on fork-ci. Each mirror sync of main brings
# upstream's workflows; none of them should run in the fork. Needs GH_TOKEN with
# actions: write.
set -euo pipefail
dir="${1:?usage: fork-guard.sh <fork-ci checkout>}"
gh api "repos/$GITHUB_REPOSITORY/actions/workflows" --paginate \
	--jq '.workflows[] | select(.state == "active") | [.id, .path, .name] | @tsv' |
	while IFS=$'\t' read -r id path name; do
		[ ! -f "$dir/$path" ] || continue
		echo "fork-guard: disabling $name ($path)"
		# Warn, do not stop: one workflow GitHub will not disable must not block the round.
		gh api -X PUT "repos/$GITHUB_REPOSITORY/actions/workflows/$id/disable" --silent ||
			echo "::warning::fork-guard could not disable $name ($path)"
	done
