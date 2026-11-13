# fork-ci: the omp integration round

This orphan branch is the default branch of `ompweb-dev/oh-my-pi` and holds only
CI: the hourly round that rebuilds each upstream omp release plus our carried
pull requests and releases it here as `v<upstream>-int.<YYYYMMDDHHMM>.g<sha7>`
(binaries that update from this fork's releases, and `omp-packages-<version>.zip`
with the npm packages ompweb's runner compiles against).

It shares no history with `main` and is **never merged** anywhere.

- `.github/workflows/omp-auto.yml`: the round (detect, rebase, integrate, build, release, escalate).
- `.github/workflows/omp.yml`: build, test, binaries, smoke, npm packages; also dispatched by `integration build`.
- `.github/workflows/publish.yml`: the rolling `oh-my-pi` release for `integration build`.
- `.github/workflows/fork-guard.yml`: disables every workflow that is not on this branch (upstream's arrive with each sync of `main`).
- `config/root--git--oh-my-pi.sh`, `config/fixups/root--git--oh-my-pi/`: the `integration` config and fixups (the script itself lives in `andrebrait/integration-ci`).
- `prompts/omp-repair.md`, `scripts/`: the repair agent's prompt and the round's helpers.

Design: kahme247/ompweb `docs/specs/2026-11-12-omp-build-in-ompweb-design.md`.

## Because this is the default branch

- Sync `main` only with `integration` or `gh repo sync ompweb-dev/oh-my-pi -b main`.
  The bare `gh repo sync` and GitHub's "Sync fork" button act on this branch.
- A pull request opened inside the fork defaults to base `fork-ci`: pass `--base main`.
- Clones check out `fork-ci`; check out `main` (or a PR branch) explicitly.
- Secrets `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `OMP_FORK_TOKEN` live in the
  `fork-build` environment (branch `fork-ci` only); only jobs that read one declare
  it, and `fork-guard.yml` keeps every other workflow disabled.
