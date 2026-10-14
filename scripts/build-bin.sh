#!/usr/bin/env bash
# Fetch/build the native sidecar binaries into OUT_DIR (default ./bin), next to
# a pg/ bundle from build-pg-bundle.sh. Ship both as extraResources.
#
# Usage: build-bin.sh [OUT_DIR] [component...]
#   components: postgrest redis ollama whisper   (default: postgrest redis)
#
#   postgrest  mac: macos-aarch64 release; libpq install name rewritten to
#              @executable_path/../pg/lib (hardened runtime ignores DYLD_*).
#              linux x64: static release. windows: libpq.dll copied from pg/.
#   redis      mac/linux: built from source (system malloc, no TLS → only
#              system libs, relocatable). windows: Microsoft Garnet (RESP-
#              compatible) published self-contained, in OUT_DIR/garnet/.
#   ollama     latest release archive; the binary needs its accelerator libs
#              in the same dir, so it is extracted flat into OUT_DIR.
#   whisper    whisper.cpp built from a pinned tag+commit (no macOS server
#              binary is published); static + embedded Metal library → one
#              relocatable binary. A stamp (tag, commit, sha256) guards reuse.
#
# Target defaults to the host; override with SIDECARS_TARGET_OS/ARCH.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/_platform.sh
source "$HERE/_platform.sh"
BIN="${1:-$PWD/bin}"
shift || true
COMPONENTS=("$@")
[ ${#COMPONENTS[@]} -eq 0 ] && COMPONENTS=(postgrest redis)
PG_DIR="${SIDECARS_PG_DIR:-$(dirname "$BIN")/pg}"
mkdir -p "$BIN"
BIN="$(cd "$BIN" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

want() { local c; for c in "${COMPONENTS[@]}"; do [ "$c" = "$1" ] && return 0; done; return 1; }

echo "==> target: $OS/$ARCH → $BIN"

if want postgrest; then
  POSTGREST_VERSION="${SIDECARS_POSTGREST_VERSION:-v14.15}"
  echo "==> PostgREST $POSTGREST_VERSION"
  _base="https://github.com/PostgREST/postgrest/releases/download/$POSTGREST_VERSION"
  if [ ! -x "$BIN/postgrest$EXE" ]; then
    case "$OS/$ARCH" in
      mac/arm64) curl -sSfL "$_base/postgrest-$POSTGREST_VERSION-macos-aarch64.tar.xz" | tar -xJ -C "$BIN" ;;
      linux/x64) curl -sSfL "$_base/postgrest-$POSTGREST_VERSION-linux-static-x64.tar.xz" | tar -xJ -C "$BIN" ;;
      linux/arm64) curl -sSfL "$_base/postgrest-$POSTGREST_VERSION-ubuntu-aarch64.tar.xz" | tar -xJ -C "$BIN" ;;
      windows/x64)
        curl -sSfL -o "$WORK/pgrst.zip" "$_base/postgrest-$POSTGREST_VERSION-windows-x64.zip"
        unzip -o -q "$WORK/pgrst.zip" -d "$BIN"
        ;;
      *) echo "no PostgREST asset for $OS/$ARCH" >&2; exit 1 ;;
    esac
    chmod +x "$BIN/postgrest$EXE" 2>/dev/null || true
  fi
  if [ "$OS" = mac ] && otool -L "$BIN/postgrest" | grep -q '/opt/homebrew/opt/libpq/lib/libpq.5.dylib'; then
    install_name_tool -change /opt/homebrew/opt/libpq/lib/libpq.5.dylib \
      @executable_path/../pg/lib/libpq.5.dylib "$BIN/postgrest"
  fi
  if [ "$OS" = windows ]; then
    _libpq="$(find "$PG_DIR" -name 'libpq*.dll' 2>/dev/null | head -1 || true)"
    [ -n "$_libpq" ] && cp "$_libpq" "$BIN/" || echo "WARN: libpq.dll not found in $PG_DIR — build pg/ first" >&2
  fi
  if [ "$OS" = mac ] && [ -d "$PG_DIR/lib" ]; then
    echo "    verify libpq resolves from pg/ without DYLD_FALLBACK:"
    env -u DYLD_FALLBACK_LIBRARY_PATH "$BIN/postgrest" --version
  fi
fi

if want redis; then
  REDIS_VERSION="${SIDECARS_REDIS_VERSION:-7.4.2}"
  if [ "$OS" = windows ]; then
    _garnet_ver="${SIDECARS_GARNET_VERSION:-v2.1.5}"
    echo "==> Garnet $_garnet_ver (windows)"
    if [ ! -f "$BIN/garnet/GarnetServer.exe" ]; then
      mkdir -p "$BIN/garnet"
      if [ -n "${SIDECARS_GARNET_WIN_URL:-}" ]; then
        curl -sSfL -o "$WORK/garnet.zip" "$SIDECARS_GARNET_WIN_URL"
        unzip -o -q "$WORK/garnet.zip" -d "$BIN/garnet"
      else
        # Release zips need a .NET runtime installed; publish self-contained instead.
        command -v dotnet >/dev/null || { echo "dotnet SDK required (or set SIDECARS_GARNET_WIN_URL)" >&2; exit 1; }
        git clone --depth 1 --branch "$_garnet_ver" https://github.com/microsoft/garnet.git "$WORK/garnet" >/dev/null 2>&1
        dotnet publish "$WORK/garnet/main/GarnetServer/GarnetServer.csproj" \
          -c Release -r win-x64 --self-contained true \
          -p:PublishSingleFile=true -p:PublishReadyToRun=true -p:IncludeNativeLibrariesForSelfExtract=false \
          -o "$BIN/garnet" >/dev/null
      fi
    fi
  else
    echo "==> Redis $REDIS_VERSION"
    if [ ! -x "$BIN/redis-server" ]; then
      curl -sSfL "https://github.com/redis/redis/archive/refs/tags/$REDIS_VERSION.tar.gz" | tar -xz -C "$WORK"
      make -C "$WORK/redis-$REDIS_VERSION" MALLOC=libc BUILD_TLS=no -j"$NPROC" redis-server >/dev/null 2>&1
      cp "$WORK/redis-$REDIS_VERSION/src/redis-server" "$BIN/redis-server"
    fi
    "$BIN/redis-server" --version | head -1 || true
  fi
fi

if want ollama; then
  echo "==> Ollama (latest)"
  if [ ! -x "$BIN/ollama$EXE" ]; then
    _base="https://github.com/ollama/ollama/releases/latest/download"
    case "$OS/$ARCH" in
      mac/*) curl -sSfL "$_base/ollama-darwin.tgz" | tar -xz -C "$BIN" ;;
      linux/x64) curl -sSfL "$_base/ollama-linux-amd64.tgz" | tar -xz -C "$BIN" ;;
      linux/arm64) curl -sSfL "$_base/ollama-linux-arm64.tgz" | tar -xz -C "$BIN" ;;
      windows/x64)
        curl -sSfL -o "$WORK/ollama.zip" "$_base/ollama-windows-amd64.zip"
        unzip -o -q "$WORK/ollama.zip" -d "$BIN"
        ;;
      *) echo "no Ollama asset for $OS/$ARCH" >&2; exit 1 ;;
    esac
    chmod +x "$BIN/ollama$EXE" 2>/dev/null || true
  fi
  echo "    $("$BIN/ollama$EXE" --version 2>/dev/null | head -1 || echo unknown)"
fi

if want whisper; then
  WHISPER_CPP_VERSION="${SIDECARS_WHISPER_CPP_VERSION:-v1.9.4}"
  WHISPER_CPP_COMMIT="${SIDECARS_WHISPER_CPP_COMMIT:-927cfce34f31707e17f2bff35c349632fb9e2c3a}"
  CMAKE_VERSION="${SIDECARS_CMAKE_VERSION:-4.4.3}"
  WHISPER_BIN="$BIN/whisper-server$EXE"
  WHISPER_STAMP="$BIN/whisper-server.stamp"
  echo "==> whisper-server $WHISPER_CPP_VERSION"
  stamp_ok() {
    [ -x "$WHISPER_BIN" ] && [ -f "$WHISPER_STAMP" ] || return 1
    [ "$WHISPER_CPP_VERSION $WHISPER_CPP_COMMIT $(shasum -a 256 "$WHISPER_BIN" | cut -d' ' -f1)" = "$(cat "$WHISPER_STAMP")" ]
  }
  if [ "$OS" = windows ]; then
    echo "    not supported on Windows yet" >&2
  elif stamp_ok; then
    echo "    reusing stamped build"
  else
    rm -f "$WHISPER_BIN" "$WHISPER_STAMP"
    if command -v uvx >/dev/null; then
      CMAKE=(uvx --from "cmake==$CMAKE_VERSION" cmake)
    elif command -v cmake >/dev/null; then
      echo "    uv not found — using system cmake, not the pinned $CMAKE_VERSION" >&2
      CMAKE=(cmake)
    else
      echo "uv or cmake is required to build whisper-server" >&2
      exit 1
    fi
    _src="$WORK/whisper.cpp"
    git clone -q --depth 1 --branch "$WHISPER_CPP_VERSION" https://github.com/ggml-org/whisper.cpp.git "$_src"
    # A moved tag must not slip in different code.
    _commit="$(git -C "$_src" rev-parse HEAD)"
    [ "$_commit" = "$WHISPER_CPP_COMMIT" ] || { echo "whisper.cpp $WHISPER_CPP_VERSION is $_commit, expected $WHISPER_CPP_COMMIT" >&2; exit 1; }
    _flags=(-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF
      -DGGML_OPENMP=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_SERVER=ON
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_SDL2=OFF -DWHISPER_CURL=OFF)
    if [ "$OS" = mac ]; then
      _flags+=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON
        "-DCMAKE_OSX_ARCHITECTURES=$([ "$ARCH" = arm64 ] && echo arm64 || echo x86_64)")
    fi
    "${CMAKE[@]}" -S "$_src" -B "$_src/build" "${_flags[@]}" >/dev/null
    "${CMAKE[@]}" --build "$_src/build" --config Release --target whisper-server -j"$NPROC" >/dev/null
    cp "$_src/build/bin/whisper-server" "$WHISPER_BIN"
    echo "$WHISPER_CPP_VERSION $WHISPER_CPP_COMMIT $(shasum -a 256 "$WHISPER_BIN" | cut -d' ' -f1)" >"$WHISPER_STAMP"
  fi
fi

echo "✓ done: $BIN"
