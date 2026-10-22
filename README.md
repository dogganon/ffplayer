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

Validate the source and the built Wasm file I/O:

```bash
npm run check
npm test
npm run test:wasm
```

The Wasm test opens and seeks a sparse file larger than 256 MiB and verifies that FFmpeg reads only small ranges. Run it after building.

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

Then choose **Open file** or **Open directory**, drop media files or a link onto the page, or choose **Open URL** to reveal the URL field, paste an HTTP(S) media URL, and choose **Open**. Multiple dropped files form a playlist. The URL field closes when opening media and reflects the selected source when reopened.

In both the browser and VS Code, edit the playback timestamp and press **Enter** to seek. It accepts seconds, `M:SS`, or `H:MM:SS`, including fractional seconds at JavaScript floating-point precision (about 15–17 significant digits); **Escape** cancels editing. The **Decimals** selector sets timestamp display precision from 0 to 6 places (default 3), and is saved with viewer settings. Display rounding does not reduce the precision of manually entered seek times. Seeking preserves whether playback was running or paused.

Remote URLs must point directly to media and allow browser access (CORS for cross-origin URLs). Servers supporting byte ranges must expose the `Content-Range` response header through CORS; these files are read on demand and support seeking. Servers returning the entire file instead are downloaded before playback, which uses memory proportional to the file size. Drag-and-drop and URL input are available only in the browser version.

The browser build is static and can be hosted on GitHub Pages. In the repository settings, set **Pages** to deploy from **GitHub Actions**, then run the **Publish Pages** workflow or push to `main`.

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
code --install-extension app/vscode/dist-package/ffplayer-0.1.0.vsix
```

Reload VS Code after installing.

### Release versioning

ffplayer uses one root package version for the browser build, VS Code extension, and git tag. Use plain `major.minor.patch` versions, for example:

```bash
npm run version -- v0.1.4
git push origin main --tags
```

Replace `v0.1.4` with the desired version. The `version:bump` script runs `npm version` with `--workspaces --include-workspace-root --allow-same-version`.

`npm version` updates the root `package.json` and workspace package manifests, creates the release commit, and creates a tag such as `v0.1.1`.

The VS Code Marketplace does not accept prerelease SemVer strings such as `0.1.0-alpha.0`. Prerelease publishing is controlled by the `vsce --pre-release` flag, not by a version suffix. Publishing the same version twice is rejected by the Marketplace, so every Marketplace upload needs a new global release version.

Publish an alpha build to the VS Code Marketplace:

```bash
VSCE_PAT=<publisher-token> npm run vscode:publish
```

For GitHub Actions, add a repository secret named `VSCE_PAT`, then run the **Publish VS Code Extension** workflow or push a `v*` tag. The workflow builds the Wasm assets and publishes the VS Code alpha. Make sure `publisher` in `app/vscode/package.json` matches your Marketplace publisher id before publishing.

## VS Code Remote

Open this repository through Remote-SSH, WSL, or Dev Containers, build the wasm assets in that workspace, then press `F5` from the remote VS Code window.

The extension declares `"extensionKind": ["workspace", "ui"]`, so VS Code can run it in either host. It reads file ranges in the workspace extension host using Node filesystem APIs and uses bundled `app/vscode/dist/` assets. No backend server is required. Virtual filesystem providers without filesystem paths are not supported.

Media is read on demand in ranges of at most 256 KiB, including when seeking. Browser files use Blob slices; VS Code files use a range-read bridge to the workspace extension host. There is no 256 MiB file-size limit. Decoding pauses at two seconds of playback lookahead (scaled by playback speed) or 64 MiB of queued decoded data (a single decode batch and decoder internals can exceed this threshold). If decoding cannot keep up with the selected speed, the playback clock waits for decoded media instead of ending early. Natural playback completion retains the final frame. The Wasm build uses Asyncify to suspend FFmpeg while ranges are read.

## Workspace Scripts

The root `package.json` is a thin npm workspace orchestrator. App-specific scripts live in:

```text
app/browser/package.json
app/vscode/package.json
app/wasm/package.json
```

The Wasm workspace shell scripts are small adapters around upstream build systems: FFmpeg uses configure/make, dav1d uses Meson/Ninja, and this project uses CMake for the Wasm binding.
