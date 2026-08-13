# ffplayer

FFmpeg-backed media player for the browser and VS Code. The player demuxes and decodes in WebAssembly, paints video tracks to canvas, plays audio through Web Audio, and does not require a backend server.

## Setup

Clone the repository and fetch submodules:

```bash
git clone --recurse-submodules <repo-url> ffplayer
cd ffplayer
```

For an existing checkout:

```bash
git submodule update --init --recursive
```

Create and activate the local conda environment:

```bash
conda env create --prefix ./.conda -f environment.yml
conda activate ./.conda
```

## Build

Build everything from the repo root:

```bash
npm run build
```

This creates the browser and VS Code assets in:

```text
app/browser/dist/
app/vscode/dist/
```

Clean generated files:

```bash
npm run clean
```

## Browser

Serve the built assets:

```bash
npm run serve
```

This starts a local server and opens the page. To serve without opening a browser:

```bash
npm run serve:no-open
```

Then choose **Open file** or **Open directory**.

## GitHub Pages

The browser build is static and can be hosted on GitHub Pages. In the repository settings, set **Pages** to deploy from **GitHub Actions**, then run the **Pages** workflow or push to `main`.

## VS Code

Build the wasm assets first:

```bash
npm run build
```

Run from source:

```bash
code .
```

Press `F5`, or run **Run and Debug: Start Debugging**. In the Extension Development Host, open a supported media file. The extension is registered as the default editor for supported media extensions; use **Open With...** to switch manually.

Package and install:

```bash
npm run package
code --install-extension app/vscode/dist-package/ffplayer-0.1.0-alpha.0.vsix
```

Reload VS Code after installing.

Publish an alpha build to the VS Code Marketplace:

```bash
VSCE_PAT=<publisher-token> npm run vscode:publish
```

For GitHub Actions, add a repository secret named `VSCE_PAT`, then run **Publish VS Code Extension** manually from the Actions tab. Make sure `publisher` in `package.json` matches your Marketplace publisher id before publishing.

## VS Code Remote

Open this repository through Remote-SSH, WSL, or Dev Containers, build the wasm assets in that workspace, then press `F5` from the remote VS Code window.

The extension declares `"extensionKind": ["ui", "workspace"]`, so VS Code can run it in either host. It uses `vscode.workspace.fs` and bundled `app/vscode/dist/` assets; it does not use a backend server or direct Node filesystem paths.

The current VS Code bridge transfers the opened file as one `Uint8Array`, so it refuses files larger than 256 MB to avoid making the extension host unresponsive. Large media should move to a range-read bridge between the webview and extension host.

## Workspace Scripts

The root `package.json` is a thin npm workspace orchestrator. App-specific scripts live in:

```text
app/browser/package.json
app/vscode/package.json
app/wasm/package.json
```

The Wasm workspace shell scripts are small adapters around upstream build systems: FFmpeg uses configure/make, dav1d uses Meson/Ninja, and this project uses CMake for the Wasm binding.
