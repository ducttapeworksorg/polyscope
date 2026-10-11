# SSH Files over SFTP, with our own SSH client

The SSH Files Source Type reaches its host through the `ssh2` library's SFTP subsystem, over one long-lived connection per Source, rather than by running the system `ssh` binary. Running `ssh` would honour every `~/.ssh/config` option for free, as the Kubernetes Sources honour kubeconfig, and would let `shell-file-source.ts` be reused. But Windows' OpenSSH has no ControlMaster, so each `stat` or `dd` would open a new connection, and that is too slow for browsing. SFTP's `readdir`, `stat` and offset reads map straight onto `FileSource`, and it needs no `sh` on the host. Follow works by polling the file's size, as on Local Filesystem.

## Consequences

We read `~/.ssh/config` ourselves, and only a subset of it: `Host`, `HostName`, `User`, `Port`, `IdentityFile` and `ProxyJump`, following `Include` (and `Match all`; other `Match` blocks are skipped). We also talk to the SSH agent ourselves (Pageant and the OpenSSH agent pipe on Windows, `SSH_AUTH_SOCK` elsewhere). Hosts are checked against `known_hosts`, which Polyscope only reads: host keys the user trusts in Polyscope are kept in its own data folder instead. Options outside that subset (Kerberos/GSSAPI, `ProxyCommand`, FIDO keys if `ssh2` lacks them) are unsupported until someone asks for them.
