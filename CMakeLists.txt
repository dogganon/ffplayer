cmake_minimum_required(VERSION 3.20)
project(ffplayer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(FFMPEG_ROOT "" CACHE PATH "FFmpeg install prefix for the Emscripten build")
set(DAV1D_ROOT "" CACHE PATH "dav1d install prefix for the Emscripten build")

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "ffplayer requires the Emscripten toolchain; use ./app/wasm/scripts/build_wasm.sh")
endif()

if(NOT FFMPEG_ROOT)
  message(FATAL_ERROR "Set -DFFMPEG_ROOT=/path/to/emscripten/ffmpeg/prefix")
endif()

find_path(AVFORMAT_INCLUDE_DIR libavformat/avformat.h
  PATHS "${FFMPEG_ROOT}/include"
  NO_DEFAULT_PATH
  NO_CMAKE_FIND_ROOT_PATH
  REQUIRED
)
find_library(AVFORMAT_LIBRARY avformat
  PATHS "${FFMPEG_ROOT}/lib"
  NO_DEFAULT_PATH
  NO_CMAKE_FIND_ROOT_PATH
  REQUIRED
)
find_library(AVCODEC_LIBRARY avcodec
  PATHS "${FFMPEG_ROOT}/lib"
  NO_DEFAULT_PATH
  NO_CMAKE_FIND_ROOT_PATH
  REQUIRED
)
find_library(AVUTIL_LIBRARY avutil
  PATHS "${FFMPEG_ROOT}/lib"
  NO_DEFAULT_PATH
  NO_CMAKE_FIND_ROOT_PATH
  REQUIRED
)
find_library(SWSCALE_LIBRARY swscale
  PATHS "${FFMPEG_ROOT}/lib"
  NO_DEFAULT_PATH
  NO_CMAKE_FIND_ROOT_PATH
  REQUIRED
)
find_library(SWRESAMPLE_LIBRARY swresample
  PATHS "${FFMPEG_ROOT}/lib"
  NO_DEFAULT_PATH
  NO_CMAKE_FIND_ROOT_PATH
  REQUIRED
)
find_library(DAV1D_LIBRARY dav1d
  PATHS "${DAV1D_ROOT}/lib" "${FFMPEG_ROOT}/../dav1d-wasm/lib"
  NO_DEFAULT_PATH
  NO_CMAKE_FIND_ROOT_PATH
)

add_executable(ffplayer_wasm app/wasm/ffplayer_wasm.cpp)
set_target_properties(ffplayer_wasm PROPERTIES OUTPUT_NAME ffplayer SUFFIX ".mjs")
target_include_directories(ffplayer_wasm PRIVATE "${AVFORMAT_INCLUDE_DIR}")
target_link_libraries(ffplayer_wasm PRIVATE
  "${AVFORMAT_LIBRARY}"
  "${AVCODEC_LIBRARY}"
  "${AVUTIL_LIBRARY}"
  "${SWSCALE_LIBRARY}"
  "${SWRESAMPLE_LIBRARY}"
)
if(DAV1D_LIBRARY)
  target_link_libraries(ffplayer_wasm PRIVATE "${DAV1D_LIBRARY}")
endif()
target_compile_options(ffplayer_wasm PRIVATE
  "-fexceptions"
)
target_link_options(ffplayer_wasm PRIVATE
  "-O1"
  "--no-entry"
  "-lembind"
  "-fexceptions"
  "-sNO_DISABLE_EXCEPTION_CATCHING=1"
  "-sMODULARIZE=1"
  "-sEXPORT_ES6=1"
  "-sEXPORT_NAME=createFFplayer"
  "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sENVIRONMENT=web,worker,node"
)

configure_file(app/browser/index.html "${CMAKE_CURRENT_BINARY_DIR}/index.html" COPYONLY)
configure_file(app/browser/browser-viewer.js "${CMAKE_CURRENT_BINARY_DIR}/browser-viewer.js" COPYONLY)
configure_file(app/vscode/vscode-viewer.js "${CMAKE_CURRENT_BINARY_DIR}/vscode-viewer.js" COPYONLY)
configure_file(app/shared/media-viewer.js "${CMAKE_CURRENT_BINARY_DIR}/media-viewer.js" COPYONLY)
configure_file(app/shared/decode-worker.js "${CMAKE_CURRENT_BINARY_DIR}/decode-worker.js" COPYONLY)
configure_file(app/shared/viewer.css "${CMAKE_CURRENT_BINARY_DIR}/viewer.css" COPYONLY)
