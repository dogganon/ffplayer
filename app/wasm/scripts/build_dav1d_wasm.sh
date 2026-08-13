#!/usr/bin/env bash
set -euo pipefail

DAV1D_VERSION="${DAV1D_VERSION:-1.5.1}"
WASM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
THIRDPARTY="$WASM_ROOT/thirdparty"
BUILD_ROOT="${FFPLAYER_WASM_BUILD_ROOT:-$WASM_ROOT/.build}"
DEPS_BUILD="$BUILD_ROOT/deps"
SRC="$THIRDPARTY/dav1d"
BUILD="$BUILD_ROOT/dav1d-build"
PREFIX="${DAV1D_PREFIX:-$DEPS_BUILD/dav1d-wasm}"
CROSS="$BUILD_ROOT/dav1d-wasm-cross.txt"

mkdir -p "$DEPS_BUILD"

command -v emcc >/dev/null || { echo "emcc not found; activate Emscripten first" >&2; exit 1; }
command -v meson >/dev/null || { echo "meson not found; update the conda env first" >&2; exit 1; }
command -v ninja >/dev/null || { echo "ninja not found" >&2; exit 1; }
command -v git >/dev/null || { echo "git not found" >&2; exit 1; }

unset CFLAGS CXXFLAGS CPPFLAGS LDFLAGS

if [[ ! -e "$SRC/.git" ]]; then
  echo "dav1d source submodule not found at $SRC" >&2
  echo "Run: git submodule update --init app/wasm/thirdparty/dav1d" >&2
  exit 1
fi

cat > "$CROSS" <<EOF
[binaries]
c = 'emcc'
ar = 'emar'
strip = 'true'
pkgconfig = 'pkg-config'

[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'
EOF

rm -rf "$BUILD" "$PREFIX"
pushd "$SRC" >/dev/null
git checkout "$DAV1D_VERSION" >/dev/null 2>&1 || true
popd >/dev/null
meson setup "$BUILD" "$SRC" \
  --cross-file "$CROSS" \
  --prefix "$PREFIX" \
  --libdir lib \
  --default-library static \
  --buildtype release \
  -Denable_tools=false \
  -Denable_tests=false \
  -Denable_asm=false \
  -Dc_thread_count=0
ninja -C "$BUILD"
ninja -C "$BUILD" install

echo "$PREFIX"
