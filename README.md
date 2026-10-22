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

Then choose **Open file** or **Open directory**.

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

Media is read on demand in ranges of at most 256 KiB, including when seeking. Browser files use Blob slices; VS Code files use a range-read bridge to the workspace extension host. There is no 256 MiB file-size limit. Decoding pauses at two seconds of lookahead or 64 MiB of queued decoded data (a single decode batch and decoder internals can exceed this threshold). The Wasm build uses Asyncify to suspend FFmpeg while ranges are read.

## Workspace Scripts

The root `package.json` is a thin npm workspace orchestrator. App-specific scripts live in:

```text
app/browser/package.json
app/vscode/package.json
app/wasm/package.json
```

The Wasm workspace shell scripts are small adapters around upstream build systems: FFmpeg uses configure/make, dav1d uses Meson/Ninja, and this project uses CMake for the Wasm binding.
