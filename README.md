# Polyscope

A cross-platform desktop viewer for browsing and reading files and logs from many systems in one editor-like interface.

Each **Source** you configure is one place to read from:

- **Local Filesystem**: a folder on this machine.
- **S3-compatible Storage**: a bucket (and optional prefix) on AWS S3, MinIO, or another S3-compatible store.
- **Kubernetes Files**: a path inside the pods of one Workload, read over `exec`.
- **Kubernetes Logs**: the pod logs of every Workload in a namespace, as snapshots or followed live.

## Installing

Download the installer for your system from the [latest release](https://github.com/ducttapeworksorg/polyscope/releases/latest):

- **Windows**: `Polyscope-<version>-x64.msi`
- **macOS**: `Polyscope-<version>-arm64.dmg` (Apple silicon) or `Polyscope-<version>-x64.dmg` (Intel)
- **Linux**: `Polyscope-<version>-x86_64.AppImage`, or the `.deb` (Debian, Ubuntu) or `.rpm` (Fedora, RHEL, openSUSE) package

The installers aren't signed yet, so each system warns you the first time you open Polyscope.

- **Windows**: SmartScreen says *Windows protected your PC*. Choose **More info**, then **Run anyway**.
- **macOS**: macOS says Polyscope can't be opened, or can't be checked for malicious software. Choose **Done** (not *Move to Trash*), then open **System Settings → Privacy & Security**, scroll down to the message about Polyscope, choose **Open Anyway**, and confirm with your password. You only need to do this once.
- **Linux**: make the AppImage executable (`chmod +x Polyscope-*.AppImage`) before running it. Some distributions need `libfuse2` installed to run AppImages.

### Updates

Polyscope checks GitHub Releases for a newer version when it starts, and every few hours after that. When one is out, the status bar says so; you can also check from **Settings → Updates**.

- The **AppImage**, **`.deb`** and **`.rpm`** download the update in the background; choose **Restart to update** to install it (the `.deb` and `.rpm` ask for your password).
- On **Windows** and **macOS**, choosing **Update available** opens the release's page, to download and run the new installer over the old one.

## Privacy

Polyscope collects **no telemetry**. It has no analytics or crash reporting, and does not phone home.

It contacts only:

- the **Sources** you configure, plus whatever they need to sign in (your AWS SSO or kubeconfig exec plugins, for example), through any proxy you set;
- GitHub Releases, to check for updates.

Secrets you enter, such as S3 secret keys, are stored encrypted using your operating system's secure storage where one is available (Keychain on macOS, DPAPI on Windows, the Secret Service on Linux).

Polyscope keeps a small log of its own errors in its user-data folder (`logs/`, about 2 MB at most). Secret keys, tokens, passwords, and credential-bearing URLs are redacted before anything is written to it, and it never leaves your machine unless you copy it yourself.

## Reporting a bug

Please [open an issue on GitHub](https://github.com/ducttapeworksorg/polyscope/issues). To help us reproduce it, open **Settings → Help → Copy diagnostics** and paste the result into the issue. It contains the Polyscope, OS, and Electron versions and the recent app log. Secret keys, tokens, passwords, credential-bearing URLs, and your home folder's path are removed first, but read it over before you post it.

## Development

```sh
npm install
git config core.hooksPath .githooks   # enforces Conventional Commits
npm run dev          # run the app with hot reload
npm run typecheck
npm test             # unit and integration tests
npm run build && npm run test:smoke   # end-to-end tests against the built app
npm run dist         # this platform's installers, in dist/
```

To release, bump `version` in `package.json`, commit, and push a matching tag (`git tag v1.2.3 && git push origin v1.2.3`); a tag with a pre-release part, like `v1.3.0-beta.1`, is published as a pre-release, which installed copies don't update to. The release workflow builds the installers on each platform and publishes them to GitHub Releases, where installed copies find them. `build/icon.png` is rendered from `build/icon.svg` by `npm run icon`.

## License

[Apache-2.0](LICENSE)
