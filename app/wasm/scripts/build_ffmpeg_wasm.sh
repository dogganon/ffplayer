#!/usr/bin/env bash
set -euo pipefail

# Minimal FFmpeg/libavformat/libavcodec build for the browser demo.
# Requires an activated Emscripten SDK: emcc/emconfigure/emmake in PATH.

FFMPEG_VERSION="${FFMPEG_VERSION:-8.0.3}"
WASM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$WASM_ROOT/../.." && pwd)"
THIRDPARTY="$WASM_ROOT/thirdparty"
BUILD_ROOT="${FFPLAYER_WASM_BUILD_ROOT:-$WASM_ROOT/build}"
DEPS_BUILD="$BUILD_ROOT/deps"
SRC="$THIRDPARTY/ffmpeg"
PREFIX="${FFMPEG_PREFIX:-${FFMPEG_ROOT:-$DEPS_BUILD/ffmpeg-wasm}}"
DAV1D_PREFIX="${DAV1D_PREFIX:-$DEPS_BUILD/dav1d-wasm}"

mkdir -p "$DEPS_BUILD"

command -v emcc >/dev/null || { echo "emcc not found; activate emsdk first" >&2; exit 1; }
command -v git >/dev/null || { echo "git not found" >&2; exit 1; }
NM="${NM:-$(command -v emnm || command -v llvm-nm || true)}"
[[ -n "$NM" ]] || { echo "neither emnm nor llvm-nm found" >&2; exit 1; }

# Conda's native compiler activation injects host CPU flags such as
# -march=nocona, which Emscripten rejects for the wasm32 target.
unset CFLAGS CXXFLAGS CPPFLAGS LDFLAGS

if [[ ! -e "$SRC/.git" ]]; then
  echo "FFmpeg source submodule not found at $SRC" >&2
  echo "Run: git submodule update --init app/wasm/thirdparty/ffmpeg" >&2
  exit 1
fi

if [[ ! -f "$DAV1D_PREFIX/lib/pkgconfig/dav1d.pc" ]]; then
  FFPLAYER_WASM_BUILD_ROOT="$BUILD_ROOT" "$WASM_ROOT/scripts/build_dav1d_wasm.sh"
fi

rm -rf "$PREFIX"
mkdir -p "$PREFIX"

pushd "$SRC" >/dev/null
git checkout "n$FFMPEG_VERSION" >/dev/null 2>&1 || true
make distclean >/dev/null 2>&1 || true
export PKG_CONFIG_LIBDIR="$DAV1D_PREFIX/lib/pkgconfig"
export PKG_CONFIG_PATH="$DAV1D_PREFIX/lib/pkgconfig"
export EM_PKG_CONFIG_PATH="$DAV1D_PREFIX/lib/pkgconfig"

# Emscripten is not a conventional FFmpeg target. This disables asm, threads,
# devices, protocols and encoders, while keeping demuxers/decoders plus
# scale/resample support so the browser demo can render decoded tracks itself.
emconfigure ./configure \
  --prefix="$PREFIX" \
  --pkg-config=pkg-config \
  --pkg-config-flags=--static \
  --target-os=none \
  --arch=x86_32 \
  --enable-cross-compile \
  --cc=emcc \
  --cxx=em++ \
  --ar=emar \
  --ranlib=emranlib \
  --nm="$NM" \
  --disable-x86asm \
  --disable-inline-asm \
  --disable-programs \
  --disable-doc \
  --disable-debug \
  --disable-network \
  --disable-autodetect \
  --disable-avdevice \
  --disable-avfilter \
  --disable-encoders \
  --disable-hwaccels \
  --disable-muxers \
  --disable-devices \
  --disable-filters \
  --disable-protocols \
  --disable-bsfs \
  --disable-pthreads \
  --disable-w32threads \
  --disable-os2threads \
  --disable-demuxers \
  --enable-libdav1d \
  --enable-demuxer=mov \
  --enable-demuxer=matroska \
  --enable-demuxer=ogg \
  --enable-demuxer=wav \
  --enable-demuxer=mp3 \
  --enable-demuxer=aac \
  --enable-demuxer=flac

emmake make -j"${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
emmake make install
popd >/dev/null

echo "$PREFIX"
