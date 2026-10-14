#!/usr/bin/env bash
# Shared platform detection for the build scripts. Sourced, not executed.
# Sets: OS (mac|linux|windows), ARCH (arm64|x64), EXE ("" | ".exe"), NPROC.
# Override the *target* (for cross-context CI) with SIDECARS_TARGET_OS /
# SIDECARS_TARGET_ARCH; otherwise inferred from `uname`. Build tools (make,
# nmake, npm pack of native binaries) still run on the HOST, so a target that
# differs from the host is only valid where that makes sense (e.g. fetching a
# prebuilt asset, not compiling).

case "${SIDECARS_TARGET_OS:-$(uname -s)}" in
  Darwin | darwin | mac) OS=mac ;;
  Linux | linux) OS=linux ;;
  MINGW* | MSYS* | CYGWIN* | Windows* | windows | win) OS=windows ;;
  *)
    echo "unsupported OS: $(uname -s) (set SIDECARS_TARGET_OS)" >&2
    exit 1
    ;;
esac

case "${SIDECARS_TARGET_ARCH:-$(uname -m)}" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *)
    echo "unsupported arch: $(uname -m) (set SIDECARS_TARGET_ARCH)" >&2
    exit 1
    ;;
esac

EXE=""
[ "$OS" = windows ] && EXE=".exe"

NPROC="$( (nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null) | head -1 )"
case "$NPROC" in '' | *[!0-9]*) NPROC=4 ;; esac
