# AGENTS.md

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `ducttapeworksorg/polyscope` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Commits

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>[(scope)][!]: <description>`, where type is one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. The `.githooks/commit-msg` hook enforces this; after cloning, enable it with:

```sh
git config core.hooksPath .githooks
```
