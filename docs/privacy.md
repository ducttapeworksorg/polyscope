# Privacy

Polyscope collects **no telemetry**. It has no analytics or crash reporting, and does not phone home.

## What it connects to

Only:

- the **Sources** you configure, plus whatever they need to sign in (your AWS SSO or kubeconfig exec plugins, for example), through any proxy you set;
- for an SSH Files Source, the server and any `ProxyJump` bastions your `~/.ssh/config` names, and your SSH agent, if you sign in through it;
- for a Docker Logs Source, the Docker engine its context reaches: the local engine's socket or named pipe, a `tcp://` address, over TLS when the context has TLS material, or, for an `ssh://` context, its host over SSH, signed in and its host key checked as for an SSH Files Source, where it runs `docker system dial-stdio`. It reads your Docker CLI config folder (`DOCKER_CONFIG`, or `~/.docker`) to find contexts, and never writes to it;
- GitHub Releases, to check for updates.

## What it stores

- **Your Sources, Environments and settings**, in Polyscope's user-data folder.
- **Secrets you enter**, such as S3 secret keys and SSH passwords and key passphrases, encrypted by your operating system's secure storage where one is available: the Keychain on macOS, DPAPI on Windows, the Secret Service on Linux. On a Linux desktop with no Secret Service running (no GNOME Keyring or KWallet), they're only obfuscated, not securely encrypted, so prefer an AWS profile there. Kubernetes credentials stay in your kubeconfig, Docker contexts' TLS certificates and keys in the Docker CLI's config folder, and SSH keys in their files or your SSH agent. Polyscope doesn't copy them. A Docker Logs Source stores its context's name, and for an `ssh://` context how it signs in, like an SSH Files Source.
- **SSH host keys you trust**, in the user-data folder (`trusted-host-keys.json`): only servers' public keys and the host names and ports they're trusted for. Polyscope reads your `~/.ssh/config`, `known_hosts` and key files, but never writes to them.
- **A local cache of Large Files** you've opened, so they can be paged through and searched. The least recently used files are removed once it passes its size cap (2 GB by default, set in **Settings**).
- **A small log of its own errors**, in the user-data folder (`logs/`, about 2 MB at most). Secret keys, tokens, passwords, passphrases, private keys and credential-bearing URLs are redacted before anything is written to it. It never leaves your machine unless you copy it yourself.

Nothing Polyscope reads is ever changed: every Source is read-only.

## Diagnostics for bug reports

**Settings → Help → Copy diagnostics** puts the Polyscope, OS and Electron versions and the recent app log on your clipboard, to paste into a bug report. The same redaction applies, and your home folder's path is replaced with `~`, in key file paths too. Read it over before you post it.

## Questions

Email [privacy@ducttapeworks.dev](mailto:privacy@ducttapeworks.dev) with any question about privacy in Polyscope.
