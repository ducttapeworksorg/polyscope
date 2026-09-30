# Installing and updating

## Downloading

Download the installer for your system from the [latest release](https://github.com/ducttapeworksorg/polyscope/releases/latest):

| System | File |
| --- | --- |
| Windows (x64) | `Polyscope-<version>-x64.exe` |
| macOS, Apple silicon | `Polyscope-<version>-arm64.dmg` |
| macOS, Intel | `Polyscope-<version>-x64.dmg` |
| Linux, any distribution | `Polyscope-<version>-x86_64.AppImage` |
| Debian, Ubuntu | the `.deb` package |
| Fedora, RHEL, openSUSE | the `.rpm` package |

On Windows, the installer puts Polyscope in your user account, with Start menu and desktop shortcuts. It doesn't need administrator rights.

## The first time you open it

The installers aren't signed yet, so each system warns you the first time you open Polyscope.

- **Windows**: SmartScreen says *Windows protected your PC*. Choose **More info**, then **Run anyway**.
- **macOS**: macOS says Polyscope can't be opened, or can't be checked for malicious software. Choose **Done** (not *Move to Trash*), then open **System Settings → Privacy & Security**, scroll down to the message about Polyscope, choose **Open Anyway**, and confirm with your password. You only need to do this once.
- **Linux**: make the AppImage executable (`chmod +x Polyscope-*.AppImage`) before running it. Some distributions need `libfuse2` installed to run AppImages.

## Updates

Polyscope checks GitHub Releases for a newer version when it starts, and every few hours after that. When one is out, the status bar says so. You can also check from **Settings → Updates**.

- On **Windows**, and from the **AppImage**, **`.deb`** and **`.rpm`**, the update downloads in the background. Choose **Restart to update** to install it. The `.deb` and `.rpm` ask for your password.
- On **macOS**, choosing **Update available** opens the release's page. Download the new `.dmg` and drag Polyscope into Applications over the old one.

Pre-releases (versions like `1.3.0-beta.1`) are never offered as updates. To try one, download it from the [releases page](https://github.com/ducttapeworksorg/polyscope/releases).
