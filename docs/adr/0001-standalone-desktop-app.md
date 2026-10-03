# Standalone desktop app rather than a VS Code extension

Polyscope ships as a standalone cross-platform desktop app (Linux, macOS, Windows) that embeds an editor-like UI, rather than as a VS Code extension using `FileSystemProvider` and Tree View APIs. An extension would have given us the file tree, tabs, editor, search and theming for free; we accept rebuilding that shell in exchange for a dedicated tool usable without VS Code and full control over the UX (notably large-file and live-log viewing, which VS Code handles poorly).

ADR 0005 adds an Extension Copy that hosts this same app inside VS Code; the decision here stands.
