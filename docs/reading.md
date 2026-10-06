# Reading files and logs

Everything opens read-only in the viewer on the right, in the same editor that powers VS Code.

## Tabs

- **Click** a file or container to **preview** it. A preview tab (in italics) is replaced by the next one you preview.
- **Double-click** it, or double-click its tab, to keep it open in a tab of its own.
- Right-click a tab for **Reload**, **Follow** (for files that can grow), **Close**, **Close Others** and **Close All**.
- The buttons at the right of the tab bar show or hide the **Minimap**, and **Reload** the active tab.

Each tab carries its Source's Environment colour. The status bar shows the active tab's Environment, Source and path, and for files its size, modified time, encoding and language.

## Files

Polyscope highlights a file by its name: YAML, JSON, XML, source code, and logs, whose levels (`INFO`, `WARN`, `ERROR`…), timestamps and numbers are coloured. It also handles:

- **Compressed files**: `.gz` and `.zst` files are shown decompressed, highlighted by the name inside (`app.log.gz` as a log).
- **Encodings**: the encoding is detected. Click it in the status bar to reopen the file as UTF-8, UTF-16 or Latin-1.
- **Language**: click it in the status bar to highlight the file as another language.
- **Binary files**: shown as a size, with **Show as hex** to see the bytes.
- **Wrap**: the **Wrap** button at the top right wraps long lines.

To watch a growing file on a Local Filesystem or Kubernetes Files Source, turn on **Follow** from its tab's menu, or right-click it in the sidebar. New lines appear as they're written.

## Logs

A container's log opens with a toolbar:

- **Last N lines**: how much of the log to fetch and keep: 1K, 10K (the default, set in **Settings**), 50K, 100K, **All**, or a number you type. Choosing **All** for a log over the Large File threshold asks first.
- **Follow**: show new lines as they're logged. **Pause** holds new lines back while you read, and **Resume** shows them.
- **Previous**: show the container's **Previous Log**, the log of its run before it last restarted, in the same tab, marked "(previous)". It has ended, so there's nothing to Follow; turn **Previous** off to go back to the current log, Following it again. It's available once the container has restarted, which a Follow notices as it happens; Kubernetes keeps only the run just before the current one, and not always that.
- **Timestamps**: start each line with when it was logged, in local time or, with **UTC**, in UTC.
- **Wrap**: wrap long lines.

While following, the log marks what happened in line: a container restarting, the connection dropping and recovering, or the container, pod or Source going away.

## Large Files

A file over the **Large File threshold** (50 MB by default) opens in the **Large File Viewer** instead of the editor. It shows the end of the file straight away, then caches the whole file on disk, with its progress shown at the top. Once it's cached:

- **Go to line** (<kbd>Ctrl</kbd>+<kbd>G</kbd>) jumps to any line. <kbd>Ctrl</kbd>+<kbd>Home</kbd> and <kbd>Ctrl</kbd>+<kbd>End</kbd> go to the start and end.
- **Search** (<kbd>Ctrl</kbd>+<kbd>F</kbd>) searches the whole file with a regular expression, optionally matching case. It lists every matching line to pick from. <kbd>Enter</kbd> and <kbd>Shift</kbd>+<kbd>Enter</kbd>, or <kbd>F3</kbd> and <kbd>Shift</kbd>+<kbd>F3</kbd>, step through the matches.
- **Open anyway in editor** opens it in the full editor, for files up to the **"Open anyway" limit** (200 MB by default).

![The Large File Viewer, searching a log for errors](images/large-file.png)

## Settings

Open **Settings** with the gear at the top of the sidebar, or <kbd>Ctrl</kbd>+<kbd>,</kbd> (<kbd>⌘</kbd>+<kbd>,</kbd> on macOS).

| Setting | Default | What it does |
| --- | --- | --- |
| Theme | Dark | Dark or light. The half-circle button at the top of the sidebar switches it too. |
| Large File threshold | 50 MB | Larger files open in the Large File Viewer. |
| "Open anyway" limit | 200 MB | Large Files up to this size can still be opened in the editor. |
| Local cache size | 2048 MB | The Large File cache. The least recently used files are removed beyond this. |
| Default "Last N lines" | 10,000 | How many lines a log fetches and keeps, unless you choose another number. |

**Settings** is also where you manage Environments, check for updates, and copy diagnostics for a bug report.

## Keyboard

Polyscope can be used without a mouse. On macOS, use <kbd>⌘</kbd> for the shortcuts marked <kbd>Ctrl</kbd>/<kbd>⌘</kbd>.

| Keys | Does |
| --- | --- |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>0</kbd> | Move to the sidebar |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>1</kbd> | Move to the viewer |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>,</kbd> | Open Settings |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Home</kbd> <kbd>End</kbd> | Move through the sidebar's rows |
| <kbd>→</kbd> / <kbd>←</kbd> | Expand / collapse a Source, folder, Workload or pod |
| Typing a name | Jump to the next row starting with it |
| <kbd>Space</kbd> | Preview the file or log |
| <kbd>Enter</kbd> | Open it in a tab of its own |
| <kbd>Ctrl</kbd>+<kbd>Tab</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Tab</kbd> | Next / previous tab (also <kbd>Ctrl</kbd>+<kbd>PageDown</kbd> / <kbd>PageUp</kbd>) |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>W</kbd> or <kbd>Ctrl</kbd>+<kbd>F4</kbd> | Close the tab |
