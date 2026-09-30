# Privacy

Polyscope collects **no telemetry**. It has no analytics or crash reporting, and does not phone home.

## What it connects to

Only:

- the **Sources** you configure, plus whatever they need to sign in (your AWS SSO or kubeconfig exec plugins, for example), through any proxy you set;
- GitHub Releases, to check for updates.

## What it stores

- **Your Sources, Environments and settings**, in Polyscope's user-data folder.
- **Secrets you enter**, such as S3 secret keys, encrypted by your operating system's secure storage where one is available: the Keychain on macOS, DPAPI on Windows, the Secret Service on Linux. On a Linux desktop with no Secret Service running (no GNOME Keyring or KWallet), they're only obfuscated, not securely encrypted, so prefer an AWS profile there. Kubernetes credentials stay in your kubeconfig. Polyscope doesn't copy them.
- **A local cache of Large Files** you've opened, so they can be paged through and searched. The least recently used files are removed once it passes its size cap (2 GB by default, set in **Settings**).
- **A small log of its own errors**, in the user-data folder (`logs/`, about 2 MB at most). Secret keys, tokens, passwords and credential-bearing URLs are redacted before anything is written to it. It never leaves your machine unless you copy it yourself.

Nothing Polyscope reads is ever changed: every Source is read-only.

## Diagnostics for bug reports

**Settings → Help → Copy diagnostics** puts the Polyscope, OS and Electron versions and the recent app log on your clipboard, to paste into a bug report. The same redaction applies, and your home folder's path is replaced with `~`. Read it over before you post it.
