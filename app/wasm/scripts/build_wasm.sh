#!/usr/bin/env bash
set -euo pipefail
WASM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$WASM_ROOT/../.." && pwd)"
BUILD_ROOT="${FFPLAYER_WASM_BUILD_ROOT:-$WASM_ROOT/build}"
DEPS_BUILD="$BUILD_ROOT/deps"
PREFIX="${FFMPEG_PREFIX:-${FFMPEG_ROOT:-$DEPS_BUILD/ffmpeg-wasm}}"
DAV1D_ROOT="${DAV1D_ROOT:-$DEPS_BUILD/dav1d-wasm}"
CMAKE_BUILD="${CMAKE_BUILD_DIR:-$BUILD_ROOT/cmake}"
BROWSER_DIST="${BROWSER_DIST_DIR:-$ROOT/app/browser/dist}"
VSCODE_DIST="${VSCODE_DIST_DIR:-$ROOT/app/vscode/dist}"

command -v emcmake >/dev/null || { echo "emcmake not found; activate emsdk first" >&2; exit 1; }

# Conda's native compiler activation injects host CPU flags such as
# -march/-mtune, which Emscripten rejects for the wasm32 target.
unset CFLAGS CXXFLAGS CPPFLAGS LDFLAGS

if [[ ! -f "$PREFIX/include/libavformat/avformat.h" ]]; then
  echo "FFmpeg wasm install headers not found under $PREFIX" >&2
  echo "Run ./app/wasm/scripts/build_ffmpeg_wasm.sh first, or set FFMPEG_PREFIX to an existing wasm FFmpeg install prefix." >&2
  exit 1
fi

emcmake cmake -S "$ROOT" -B "$CMAKE_BUILD" \
  -UCMAKE_C_FLAGS \
  -UCMAKE_CXX_FLAGS \
  -UCMAKE_EXE_LINKER_FLAGS \
  -UAVFORMAT_INCLUDE_DIR \
  -UAVFORMAT_LIBRARY \
  -UAVCODEC_LIBRARY \
  -UAVUTIL_LIBRARY \
  -USWSCALE_LIBRARY \
  -USWRESAMPLE_LIBRARY \
  -UDAV1D_LIBRARY \
  -DCMAKE_BUILD_TYPE=Release \
  -DFFMPEG_ROOT="$PREFIX" \
  -DDAV1D_ROOT="$DAV1D_ROOT"
cmake --build "$CMAKE_BUILD" -j

rm -rf "$BROWSER_DIST" "$VSCODE_DIST"
mkdir -p "$BROWSER_DIST" "$VSCODE_DIST"

cp "$CMAKE_BUILD/index.html" \
   "$CMAKE_BUILD/browser-viewer.js" \
   "$CMAKE_BUILD/media-viewer.js" \
   "$CMAKE_BUILD/viewer.css" \
   "$CMAKE_BUILD/ffplayer.mjs" \
   "$CMAKE_BUILD/ffplayer.wasm" \
   "$BROWSER_DIST/"

cp "$CMAKE_BUILD/vscode-viewer.js" \
   "$CMAKE_BUILD/media-viewer.js" \
   "$CMAKE_BUILD/viewer.css" \
   "$CMAKE_BUILD/ffplayer.mjs" \
   "$CMAKE_BUILD/ffplayer.wasm" \
   "$VSCODE_DIST/"

echo "Browser files: $BROWSER_DIST/index.html, $BROWSER_DIST/ffplayer.mjs, $BROWSER_DIST/ffplayer.wasm"
echo "VS Code files: $VSCODE_DIST/ffplayer.mjs, $VSCODE_DIST/ffplayer.wasm"
echo "Serve with: npm run serve"
