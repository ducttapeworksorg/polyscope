# Polyscope for VS Code

Browse and read files and logs from many systems without leaving VS Code.

The Polyscope icon in the activity bar opens the Polyscope sidebar, with the same Sources tree as the [Polyscope desktop app](https://github.com/ducttapeworksorg/polyscope). Files open read-only in VS Code's own editor, compressed ones (`.gz`, `.zst`) decompressed.

Polyscope for VS Code keeps its own Sources and settings, apart from the desktop app's. Under Remote-SSH, WSL and Dev Containers it runs on the remote machine, so a Local Filesystem Source browses the remote's disk.
