# Electron with TypeScript throughout

We build on Electron with TypeScript in both main and renderer processes, embedding Monaco. Tauri 2 (Rust, ~10 MB installers) and Wails (Go, best-in-class `client-go`) were the main alternatives; both rely on the OS webview, and WebKitGTK on Linux renders Monaco noticeably worse. We accept ~100 MB installers and higher memory use in exchange for identical rendering on every OS, Monaco running in the environment it was built for, and a single language across the codebase.
