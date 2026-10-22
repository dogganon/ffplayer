# ffplayer

FFmpeg-backed media viewer for VS Code. This alpha build bundles the Wasm player assets and does not require a backend server.

Open a supported media file in VS Code; ffplayer is registered as the default editor for common audio/video container extensions.

Files are read on demand in bounded ranges. For SSH, WSL, and containers, install/run the extension in the workspace extension host. Virtual filesystem documents without a filesystem path are not supported.
