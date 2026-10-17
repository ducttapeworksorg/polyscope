# AGENTS.md

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `ducttapeworksorg/polyscope` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Commits

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/): `<type>[(scope)][!]: <description>`, where type is one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. The `.githooks/commit-msg` hook enforces this; after cloning, enable it with:

```sh
git config core.hooksPath .githooks
```

## Factory

What the factory agents need to build and check a change here. [Development](docs/development.md) has the details.

- **Setup** in a fresh checkout: `npm ci`, then `git config core.hooksPath .githooks`.
- **Branches**: `<type>/<issue>-<slug>`, `<type>` being the change's Conventional Commits type: `feat/142-gcs-source`.
- **Validate**, in order, all must pass: `npm run typecheck`, `npm run build`, `npm test`, then `npm run test:smoke` against that build.
  - When `src/extension/`, `src/renderer/extension/`, `extension/` or `scripts/build-extension.mts` change, or anything the Extension Copy shares with the app: `npm run test:extension` and `npm run extension:vsix`.
  - On Linux without a display, run the smoke and extension tests under `xvfb-run --auto-servernum`.
  - The integration tests that need real backends (S3, Azure, Kubernetes, sshd, Docker, the systemd journal) are skipped unless configured. CI runs them; don't set them up.
- **Run some tests**: `npx vitest run <file or folder>`; one smoke spec: `npx playwright test tests/smoke/<file>`.
- **Test files**: `src/**/*.test.ts`, `tests/**`, and the core's test stand-ins, `src/main/core/*-test-*.ts`.
- **Evidence** of a visible change: the smoke tests that cover it, and the README screenshots. A change to the UI reruns them (`npm run build && npm run extension:vsix && npm run screenshots`) and commits the changed `docs/images/*.png`, which show it.
- **Security hot spots**: secrets and settings (`src/main/core/secret-store.ts`, `settings-store.ts`, `src/extension/secret-storage.ts`); redaction of logs and diagnostics (`src/main/redact.ts`, `diagnostics.ts`); what the renderer may ask of the main process (`src/preload/`, `src/main/ipc.ts`, `src/extension/bridge/`); SSH host keys and connections (`src/main/core/host-keys.ts`, `ssh-*.ts`); cloud sign-in and credentials (`aws-*.ts`, `azure-*`, `kubeconfig.ts`); proxies and certificates (`network-agents.ts`, `proxy-env.ts`); updates (`src/main/updates.ts`); and CI and releases (`.github/workflows/`, `scripts/release.mts`).
- **Never** run `npm run release` or `npm run dist`, publish anything, or push to `main`.
