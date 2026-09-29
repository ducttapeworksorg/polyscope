# Polyscope

A cross-platform desktop viewer for browsing and reading files and logs from many systems in one editor-like interface.

Each **Source** you configure is one place to read from:

- **Local Filesystem**: a folder on this machine.
- **S3-compatible Storage**: a bucket (and optional prefix) on AWS S3, MinIO, or another S3-compatible store.
- **Kubernetes Files**: a path inside the pods of one Workload, read over `exec`.
- **Kubernetes Logs**: the pod logs of every Workload in a namespace, as snapshots or followed live.

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
```

## License

[Apache-2.0](LICENSE)
