# shellcheck shell=bash
# fork-token.sh — sourced by the publishing scripts. Writes to the fork use the
# workflow's own token (TOKEN, GITHUB_TOKEN) first. GitHub refuses that token
# whenever the write would add or change a workflow file (an upstream release that
# touched .github/workflows/), so only then the write is retried once with
# FALLBACK_TOKEN (OMP_FORK_TOKEN). The log says which token wrote, so the
# fallback can be dropped if it never fires.
WORKFLOWS_REFUSAL='refusing to allow a GitHub App to create or update workflow|without .?workflows.? permission'

# fork_write <cmd...>: runs cmd with GH_TOKEN set to the token to use; cmd output goes to stderr.
fork_write() {
	local out
	if out="$(GH_TOKEN="${TOKEN:?}" "$@" 2>&1)"; then
		[ -z "$out" ] || printf '%s\n' "$out" >&2
		echo "fork-write: token=github: $1" >&2
		return 0
	fi
	printf '%s\n' "$out" >&2
	grep -qE "$WORKFLOWS_REFUSAL" <<< "$out" || return 1
	[ -n "${FALLBACK_TOKEN:-}" ] || { echo "fork-write: refused for the workflows permission and no OMP_FORK_TOKEN" >&2; return 1; }
	GH_TOKEN="$FALLBACK_TOKEN" "$@" >&2
	echo "fork-write: token=pat: $1" >&2
}

# fork_push [git push options] <refspec...>: git push to $FORK with $GH_TOKEN (use through fork_write).
fork_push() {
	local -a opts=() refs=()
	local a
	for a; do if [[ "$a" == -* ]]; then opts+=("$a"); else refs+=("$a"); fi; done
	git push "${opts[@]}" "https://x-access-token:$GH_TOKEN@github.com/${FORK:?}.git" "${refs[@]}"
}
