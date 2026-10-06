# Development

Polyscope is an Electron app written in TypeScript: React and Monaco in the renderer, and a core in the main process that talks to each Source's backend. It also ships as a VS Code extension, the [Extension Copy](#the-extension-copy). Node 24 is what CI uses.

```sh
npm install
git config core.hooksPath .githooks   # enforces Conventional Commits
npm run dev          # run the app with hot reload
npm run typecheck
npm test             # unit and integration tests
npm run build && npm run test:smoke   # end-to-end tests against the built app
npm run dist         # this platform's installers (and Windows' portable downloads), in dist/
npm run test:extension   # the Extension Copy's tests, in real VS Code
```

A build run from source (`npm run dev` or `npm start`) keeps its Sources, settings and secrets in `Ducttapeworks/Polyscope Dev` in the OS's app-data folder (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS, `~/.config` on Linux), apart from an installed copy's `Ducttapeworks/Polyscope`, so the two can run side by side. `--user-data-dir=<folder>` points either at another folder.

## Where things are

- `src/main/core/`: the core. Sources, Source Types and their backends, following, the Large File cache, settings and secrets.
- `src/renderer/`: the UI. The sidebar, tabs, viewers, dialogs and status bar. Its strings are in `src/renderer/src/i18n/en.ts`.
- `src/shared/`: the API between the two.
- `tests/smoke/`: Playwright tests that drive the built app.
- `CONTEXT.md`: the domain's language (Source, Source Type, Environment, Follow, Large File…). `docs/adr/` holds the architecture decisions.

## The Extension Copy

Polyscope for VS Code (ADR 0005) runs the same core in VS Code's extension host, and the same UI in its webviews. It has its own manifest and build, apart from the app's:

- `src/extension/`: the extension host's side. Activation, the `polyscope` file system VS Code's editor reads files through, the sidebar view and viewer tabs, tab decorations, and secrets in VS Code's SecretStorage. `bridge/` carries the UI's `window.polyscope` calls and the core's events between the webviews and the core.
- `src/renderer/extension/`: the sidebar's and viewer tabs' pages, built from the app's UI components.
- `extension/`: the manifest (`package.json`), the README shown in VS Code's Extensions view, and the activity bar icon. Builds land in `extension/dist`. The manifest's version doesn't matter: packaging always uses the app's.
- `scripts/build-extension.ts`: the build.
- `tests/extension/`: the integration tests, which drive real VS Code.

```sh
npm run extension:build   # the extension and its webviews, into extension/dist
npm run extension:vsix    # also packages them as extension/polyscope-<version>.vsix
npm run test:extension    # the integration tests, in a VS Code downloaded into .vscode-test the first time
```

`npm run test:extension` runs the suite twice against one VS Code profile, the second time as if the window had been reloaded. Its tests switch `polyscope.ownViewer` as they go, so both modes are covered. Like the core's integration tests, its S3 and Kubernetes tests are skipped unless their backends are configured (see [Integration tests](#integration-tests)).

To run the extension from source, build it, then start VS Code (or another editor built on it) with it loaded in place of any installed copy:

```sh
npm run extension:build
code --extensionDevelopmentPath="$PWD/extension" --user-data-dir="$PWD/.scratch/vscode"
```

`--user-data-dir` is optional. It gives the run a VS Code profile of its own, so it keeps its Sources and secrets apart from your everyday VS Code's. Without it, a copy run from source and an installed one share them. There's no hot reload: after a change, build again and run **Developer: Reload Window** in that window.

To debug:

- **The extension host**: add `--inspect-extensions=9229` to the `code` command, then attach a Node debugger to port 9229, for example with VS Code's **Debug: Attach to Node Process**. The build has no source maps, so breakpoints go in `extension/dist/extension.js`, which isn't minified.
- **The sidebar and viewer tabs**: run **Developer: Open Webview Developer Tools** with the webview focused.
- **The log**: Polyscope's log is in `logs/` in the extension's global storage folder, `User/globalStorage/ducttapeworks.polyscope` in the user data folder. **Copy diagnostics** in Polyscope's Settings includes its recent lines.

## Integration tests

Some tests run against real backends, and are skipped unless they're configured:

- **S3**: set `POLYSCOPE_TEST_S3_ENDPOINT`, `POLYSCOPE_TEST_S3_ACCESS_KEY` and `POLYSCOPE_TEST_S3_SECRET_KEY` to an S3-compatible store (CI uses [RustFS](https://github.com/rustfs/rustfs)), then `npx vitest run src/main/core/s3`. `npm run test:extension` also runs the Extension Copy's S3 tests then.
- **Kubernetes**: apply `tests/kind/seed.yaml` to a cluster (CI uses [kind](https://kind.sigs.k8s.io/)), set `POLYSCOPE_TEST_KUBE_CONTEXT`, `POLYSCOPE_TEST_KUBE_RESTRICTED_CONTEXT`, `POLYSCOPE_TEST_KUBE_NAMESPACE` and `POLYSCOPE_TEST_KUBE_FILES_NAMESPACE`, then `npx vitest run src/main/core/kubernetes`. `npm run test:extension` also runs the Extension Copy's Kubernetes tests then. `.github/workflows/ci.yml` shows the full setup.

## Screenshots

The screenshots in `docs/images` are rendered by `npm run build && npm run extension:vsix && npm run screenshots`: the desktop app's by `scripts/screenshots/readme.spec.ts`, from the built app, and Polyscope for VS Code's (`vscode-*.png`) by `scripts/screenshots/vscode.spec.ts`, which installs the packaged `.vsix` into a VS Code of its own, downloaded into `.vscode-test` the first time. Both use `scripts/screenshots/samples.ts`'s folder of sample logs and stand-in Kubernetes API server, so they need no cluster and show nothing real. To render only one set, name its spec: `npm run screenshots -- vscode`. Rerun them after changing the UI.

The extension's README, which the Marketplace and Open VSX show, links its screenshots from `main` on GitHub, so a new screenshot appears there once it's pushed.

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

The release workflow checks the tag matches `package.json`'s version, then builds the installers on each platform, and the Extension Copy's `polyscope-<version>.vsix` at that same version, and publishes them to GitHub Releases, where installed copies find them. A tag with a pre-release part, like `v1.3.0-beta.1`, is published as a pre-release, which installed copies don't update to.

Once the GitHub release is out, the workflow publishes its `.vsix` to Open VSX, marked as a pre-release for a pre-release tag, and, for a release only, to the VS Code Marketplace, which takes no pre-release part in a version. Neither takes an access token:

- Open VSX trusts the workflow's GitHub OIDC token directly (`ovsx publish --trusted-publishing`).
- For the VS Code Marketplace, the `vs-marketplace` job signs in to Azure as a Microsoft Entra app, with a federated credential for the `vs-marketplace` environment, and publishes as that app (`vsce publish --azure-credential`). The app is a Contributor on the `ducttapeworks` publisher. Its IDs are the repository variables `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`, and the environment only lets `v*.*.*` tags deploy.

### Pre-releases

Name pre-releases `alpha` or `beta` (`v1.3.0-alpha.1`, `v1.3.0-beta.2`), and nothing else. electron-updater ranks just these two below a release, and a copy on a pre-release updates to anything at least as stable as itself:

| Installed | Updates to |
| --- | --- |
| a release | later releases |
| a beta | later betas and releases |
| an alpha | later alphas, betas and releases |

Any other name, like `rc`, `nightly` or `canary`, is a *custom channel* to electron-updater: a copy on it only ever updates to later versions with the same name, never to a release. A `v1.3.0-rc.1` install would keep saying it's up to date after `v1.3.0` is out, until someone installs a release over it by hand. So a release candidate is a beta here: tag it `v1.3.0-beta.3`, not `v1.3.0-rc.1`.

This is only how copies that update themselves behave. On macOS and in Windows Portable Copies the app asks GitHub for the latest release itself (ADR 0003), so whatever a pre-release is called, those copies are offered the next release and never a later pre-release.
