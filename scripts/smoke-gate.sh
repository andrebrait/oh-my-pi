#!/usr/bin/env bash
# smoke-gate.sh <job-name regex> [jobs.json]
#
# Decides whether a build may publish although some of its jobs did not succeed.
# GitHub sometimes never acquires a macOS arm64 runner: the darwin-arm64 smoke job
# is then cancelled (or failed) without a runner and without running a step. That
# job alone is excused; any other non-successful job among those whose name matches
# the regex blocks, as does a darwin-arm64 smoke that ran and failed.
#
# Reads the jobs of this run (GET actions/runs/$GITHUB_RUN_ID/jobs, latest attempt)
# or, for a dry run, the saved output of that call. Prints `ok=true|false` and
# `unsmoked=true|false` (darwin-arm64 published without its smoke) for
# $GITHUB_OUTPUT; the reasons go to stderr.
set -euo pipefail
re="${1:?usage: smoke-gate.sh <job-name regex> [jobs.json]}"
if [ -n "${2:-}" ]; then
	jobs="$(cat "$2")"
else
	jobs="$(gh api "repos/${GITHUB_REPOSITORY:?}/actions/runs/${GITHUB_RUN_ID:?}/jobs" --paginate)"
fi
# --paginate prints one object per page. Reason lines go to stderr, the rest to stdout.
jq -rs --arg re "$re" '
	[.[].jobs[] | select(.name | test($re))] as $jobs
	| [$jobs[] | select(.conclusion != "success")] as $bad
	| [$bad[] | select((.name | test("smoke \\(darwin-arm64,"))
		and (.conclusion == "cancelled" or .conclusion == "failure")
		and ((.steps | length) == 0 or (.runner_name // "") == ""))] as $norunner
	| ($jobs | length) as $n
	| "smoke-gate: \($n) jobs match /\($re)/",
	  ($bad[] | "smoke-gate: \(.name): \(.conclusion // .status), \(.steps | length) steps, runner \"\(.runner_name // "")\""),
	  "ok=\($n > 0 and ($bad | length) == ($norunner | length))",
	  "unsmoked=\(($norunner | length) > 0)"
' <<< "$jobs" | awk '/^smoke-gate: / { print > "/dev/stderr"; next } { print }'
