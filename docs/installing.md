# Installing and updating

To use Polyscope inside VS Code instead, see [Polyscope for VS Code](#polyscope-for-vs-code).

## Downloading

Download Polyscope for your system from the [latest release](https://github.com/ducttapeworksorg/polyscope/releases/latest):

| System | File |
| --- | --- |
| Windows (x64) | `Polyscope-<version>-x64.exe` |
| Windows (x64), without installing, single file | `Polyscope-<version>-x64-portable.exe` |
| Windows (x64), without installing, to extract | `Polyscope-<version>-x64-portable.zip` |
| macOS, Apple silicon | `Polyscope-<version>-arm64.dmg` |
| macOS, Intel | `Polyscope-<version>-x64.dmg` |
| Linux, any distribution | `Polyscope-<version>-x86_64.AppImage` |
| Debian, Ubuntu | the `.deb` package |
| Fedora, RHEL, openSUSE | the `.rpm` package |

On Windows, the installer puts Polyscope in your user account, with Start menu and desktop shortcuts. It doesn't need administrator rights.

## Running without installing

If you can't install software on your computer but can run a program you've downloaded, use a portable download instead of an installer:

- **Windows**: there are two portable downloads.
  - `Polyscope-<version>-x64-portable.exe` is a single file you can run from anywhere. It unpacks itself into your temporary folder each time it starts, so it takes a few seconds longer to open. Some managed computers won't run programs from the temporary folder. If yours won't, use the `.zip`.
  - `Polyscope-<version>-x64-portable.zip`: extract it into a folder of its own, then run `Polyscope.exe` from there. It starts faster than the portable `.exe`.
- **Linux**: the AppImage already runs without installing.
- **macOS**: the `.dmg` doesn't need administrator rights. Drag Polyscope into the `Applications` folder in your home folder (`~/Applications`) instead of the main one.

A portable copy keeps your Sources, Environments, settings and secrets in the same place an installed copy does. If you use both on one computer, they share them.

## The first time you open it

The downloads aren't signed yet, so each system warns you the first time you open Polyscope.

- **Windows**: SmartScreen says *Windows protected your PC*, for the installer and the portable `.exe` alike. Choose **More info**, then **Run anyway**.
- **macOS**: macOS says Polyscope can't be opened, or can't be checked for malicious software. Choose **Done** (not *Move to Trash*), then open **System Settings → Privacy & Security**, scroll down to the message about Polyscope, choose **Open Anyway**, and confirm with your password. You only need to do this once.
- **Linux**: make the AppImage executable (`chmod +x Polyscope-*.AppImage`) before running it. Some distributions need `libfuse2` installed to run AppImages.

## Updates

Polyscope checks GitHub Releases for a newer version when it starts, and every few hours after that. When one is out, the status bar says so. You can also check from **Settings → Updates**.

- On **Windows**, when Polyscope was installed, and from the **AppImage**, **`.deb`** and **`.rpm`**, the update downloads in the background. Choose **Restart to update** to install it. The `.deb` and `.rpm` ask for your password.
- On **ChromeOS**, from the `.deb`, choosing **Update available** opens the release's page. Download the new `.deb` and open it from the Files app to install it. (Its Linux can't ask for the password the update needs.)
- From a Windows **portable** download, choosing **Update available** opens the release's page. Download the new portable `.exe` or `.zip` and use it in place of the old one.
- On **macOS**, choosing **Update available** opens the release's page. Download the new `.dmg` and drag Polyscope into Applications over the old one.

Pre-releases (versions like `1.3.0-beta.1`) are never offered as updates to a release. To try one, download it from the [releases page](https://github.com/ducttapeworksorg/polyscope/releases).

Once you're on a pre-release, which updates you get depends on how far along it is:

- A **beta** (`1.3.0-beta.1`) updates to later betas and to releases, so it moves on to `1.3.0` when that's out.
- An **alpha** (`1.3.0-alpha.1`) updates to later alphas, to betas and to releases.
- On **macOS** and from a Windows **portable** download, a pre-release is only offered the next release, not later pre-releases. Download those from the releases page.

## Polyscope for VS Code

Polyscope also comes as an extension for VS Code 1.100 or later and for editors built on it, like VSCodium, Cursor and Windsurf. Each release has it as `polyscope-<version>.vsix`, at the same version as the app. It isn't on a marketplace yet, so you install it by hand:

- In the editor, open the **Extensions** view, choose **…** at its top, then **Install from VSIX…**, and pick the downloaded file.
- Or, from a terminal: `code --install-extension polyscope-<version>.vsix` (`codium`, `cursor` or `windsurf` in those editors).

In a Remote-SSH, WSL or Dev Containers window, install it from that window, so it runs on the remote machine: a Local Filesystem Source then browses the remote's disk, and Kubernetes and S3 Sources use the remote's kubeconfig and AWS profiles. If it's already installed on your own machine, the **Extensions** view offers to install it on the remote too.

### Using it

The Polyscope icon in the activity bar opens the Polyscope sidebar, with the same **Sources** tree as the app. Add Sources there just as in the app. The gear at the top of the sidebar opens Polyscope's **Settings**, where you manage Environments and set the Large File threshold, the "open anyway" limit and the default Last N lines.

Files open in VS Code's own editor, read-only, so its tabs, search, highlighting, split views and **Reopen with Encoding** all work as they do for your own files. Compressed files open decompressed. A tab is labelled with its file's Source and path, and tinted with its Environment's colour.

What VS Code's editor can't do opens in a Polyscope viewer tab instead: a file you **Follow**, a Kubernetes **Log Stream** with its toolbar, and a **Large File**, which a viewer tab can page through without downloading all of it. Closing a viewer tab stops its Follow. VS Code reopens your editor tabs when it reloads, but not Polyscope's viewer tabs.

VS Code's **Polyscope: Own Viewer** setting (`polyscope.ownViewer`, on by default) chooses this. **Open VS Code settings** in Polyscope's Settings goes straight to it. Turn it off to open everything in VS Code's editor:

- Log Streams open as a snapshot of their Last N lines.
- Follow isn't offered.
- A Large File opens only if it's within Polyscope's "open anyway" limit. A bigger one is refused, with an offer to turn the setting back on.

The sidebar and viewer tabs take the colours of your VS Code theme and follow it when it changes. Environment and status colours stay Polyscope's.

### Its own Sources

The extension keeps its own Sources, Environments and settings, apart from the app's. Sources you've added in the app don't appear in the extension, nor the other way round. Add them again in each. S3 secret keys are kept in VS Code's secret storage, which your operating system's keychain encrypts where it has one.

### Updating it

An extension installed from a `.vsix` doesn't update itself. To update, install the newer release's `.vsix` the same way: it replaces the old version, and your Sources and settings stay.
