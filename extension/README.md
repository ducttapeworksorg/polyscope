# Polyscope for VS Code

Browse and read files and logs from many systems without leaving VS Code.

The Polyscope icon in the activity bar opens the Polyscope sidebar, with the same Sources tree as the [Polyscope desktop app](https://github.com/ducttapeworksorg/polyscope). Files open read-only in VS Code's own editor, compressed ones (`.gz`, `.zst`) decompressed. Their tabs are labelled with their Source and tinted with its Environment's colour, so a file from prod stands out. The sidebar and viewer tabs take the colours of your VS Code theme.

Followed files, Kubernetes Log Streams and Large Files open in a Polyscope viewer tab, which appends live lines and shows a multi-gigabyte file without downloading all of it. Turn off the `polyscope.ownViewer` setting to open everything in VS Code's editor instead: Log Streams as a snapshot of their Last N lines, Large Files only up to the "open anyway" limit in Polyscope's Settings, and no Follow.

Polyscope for VS Code keeps its own Sources and settings, apart from the desktop app's. S3 secret keys are kept in VS Code's secret storage, encrypted by your operating system's keychain where it has one. Under Remote-SSH, WSL and Dev Containers it runs on the remote machine, so a Local Filesystem Source browses the remote's disk and Kubernetes Sources use the remote's kubeconfig, with its auth plugins.
