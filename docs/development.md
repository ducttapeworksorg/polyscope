# Development

Polyscope is an Electron app written in TypeScript: React and Monaco in the renderer, and a core in the main process that talks to each Source's backend. Node 24 is what CI uses.

```sh
npm install
git config core.hooksPath .githooks   # enforces Conventional Commits
npm run dev          # run the app with hot reload
npm run typecheck
npm test             # unit and integration tests
npm run build && npm run test:smoke   # end-to-end tests against the built app
npm run dist         # this platform's installers (and Windows' portable downloads), in dist/
```

A build run from source (`npm run dev` or `npm start`) keeps its Sources, settings and secrets in `Ducttapeworks/Polyscope Dev` in the OS's app-data folder (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS, `~/.config` on Linux), apart from an installed copy's `Ducttapeworks/Polyscope`, so the two can run side by side. `--user-data-dir=<folder>` points either at another folder.

## Where things are

- `src/main/core/`: the core. Sources, Source Types and their backends, following, the Large File cache, settings and secrets.
- `src/renderer/`: the UI. The sidebar, tabs, viewers, dialogs and status bar. Its strings are in `src/renderer/src/i18n/en.ts`.
- `src/shared/`: the API between the two.
- `tests/smoke/`: Playwright tests that drive the built app.
- `CONTEXT.md`: the domain's language (Source, Source Type, Environment, Follow, Large File…). `docs/adr/` holds the architecture decisions.

## Integration tests

Some tests run against real backends, and are skipped unless they're configured:

- **S3**: set `POLYSCOPE_TEST_S3_ENDPOINT`, `POLYSCOPE_TEST_S3_ACCESS_KEY` and `POLYSCOPE_TEST_S3_SECRET_KEY` to an S3-compatible store (CI uses [RustFS](https://github.com/rustfs/rustfs)), then `npx vitest run src/main/core/s3`.
- **Kubernetes**: apply `tests/kind/seed.yaml` to a cluster (CI uses [kind](https://kind.sigs.k8s.io/)), set `POLYSCOPE_TEST_KUBE_CONTEXT`, `POLYSCOPE_TEST_KUBE_RESTRICTED_CONTEXT`, `POLYSCOPE_TEST_KUBE_NAMESPACE` and `POLYSCOPE_TEST_KUBE_FILES_NAMESPACE`, then `npx vitest run src/main/core/kubernetes`. `.github/workflows/ci.yml` shows the full setup.

## Screenshots

The screenshots in `docs/images` are rendered from the built app by `npm run build && npm run screenshots`. The script (`scripts/screenshots/readme.spec.ts`) seeds a folder of sample logs and a stand-in Kubernetes API server, so it needs no cluster and shows nothing real. Rerun it after changing the UI.

## Icons

`build/icon.png` is rendered from `build/icon.svg` by `npm run icon`.

## Branches and pull requests

Work on a short-lived branch off `main`, named for the change's Conventional Commits type: `feat/portable-exe`, `fix/kube-reconnect`, `docs/installing`.

```sh
git switch main && git pull
git switch -c feat/portable-exe
# commit, then
git push -u origin feat/portable-exe
gh pr create --base main --fill-first
```

Pull requests are merged with **Rebase and merge**, so each commit lands on `main` as written. Every commit message counts, and the PR's title doesn't; `--fill-first` just borrows the first commit's. CI runs on the pull request and again on each push to it. GitHub deletes the branch once it's merged; delete yours too:

```sh
git switch main && git pull
git branch -D feat/portable-exe   # -D: rebasing gave the commits new hashes, so git thinks they're unmerged
```

## Releasing

Bump the version on a branch like any other change, and merge it:

```sh
git switch -c chore/release-1.2.3
npm version 1.2.3 --no-git-tag-version   # updates package.json and package-lock.json
git commit -am "chore: release 1.2.3"
git push -u origin chore/release-1.2.3
gh pr create --base main --fill-first
```

Once it's merged, tag `main`, not your branch, since rebasing changed the commit's hash:

```sh
git switch main && git pull
git tag v1.2.3 && git push origin v1.2.3
```

The release workflow checks the tag matches `package.json`'s version, then builds the installers on each platform and publishes them to GitHub Releases, where installed copies find them. A tag with a pre-release part, like `v1.3.0-beta.1`, is published as a pre-release, which installed copies don't update to.
