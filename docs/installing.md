# Installing and updating

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
- From a Windows **portable** download, choosing **Update available** opens the release's page. Download the new portable `.exe` or `.zip` and use it in place of the old one.
- On **macOS**, choosing **Update available** opens the release's page. Download the new `.dmg` and drag Polyscope into Applications over the old one.

Pre-releases (versions like `1.3.0-beta.1`) are never offered as updates to a release. To try one, download it from the [releases page](https://github.com/ducttapeworksorg/polyscope/releases).

Once you're on a pre-release, which updates you get depends on how far along it is:

- A **beta** (`1.3.0-beta.1`) updates to later betas and to releases, so it moves on to `1.3.0` when that's out.
- An **alpha** (`1.3.0-alpha.1`) updates to later alphas, to betas and to releases.
- On **macOS** and from a Windows **portable** download, a pre-release is only offered the next release, not later pre-releases. Download those from the releases page.
