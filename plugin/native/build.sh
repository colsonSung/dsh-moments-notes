#!/bin/bash
# Build the Moments desktop float.
#
# The helper is a small AppKit/SwiftUI accessory app that the Host starts as a
# child process and drives over JSONL. It is the desktop-level counterpart of
# the in-app float: it stays above ordinary windows on every Space.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-release}"

# `xcrun` refuses to work until the Xcode license is accepted, so the compiler
# and the SDK are located by hand whenever the license has not been agreed.
resolve_compiler() {
  if [[ -n "${SWIFTC:-}" ]]; then
    printf '%s\n' "${SWIFTC}"
    return 0
  fi
  local found
  if found="$(xcrun -f swiftc 2>/dev/null)" && [[ -x "${found}" ]]; then
    printf '%s\n' "${found}"
    return 0
  fi
  for candidate in \
    "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc" \
    "/Library/Developer/CommandLineTools/usr/bin/swiftc"; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

resolve_sdk() {
  if [[ -n "${SDKROOT:-}" && -d "${SDKROOT}" ]]; then
    printf '%s\n' "${SDKROOT}"
    return 0
  fi
  local found
  if found="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null)" && [[ -d "${found}" ]]; then
    printf '%s\n' "${found}"
    return 0
  fi
  for candidate in \
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk" \
    "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk"; do
    if [[ -d "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

COMPILER="$(resolve_compiler)" || {
  printf 'moments float: no Swift compiler found; install Xcode or the Command Line Tools\n' >&2
  exit 1
}
SDK="$(resolve_sdk)" || {
  printf 'moments float: no macOS SDK found; install Xcode or the Command Line Tools\n' >&2
  exit 1
}

TARGET="$(uname -m)-apple-macosx13.0"
mkdir -p "$ROOT/bin"

case "$MODE" in
  release)
    "${COMPILER}" -sdk "$SDK" -swift-version 5 -target "$TARGET" -O -parse-as-library \
      "$ROOT/MomentsFloat.swift" \
      -framework SwiftUI \
      -framework AppKit \
      -o "$ROOT/bin/moments-float"
    printf 'moments float: built %s\n' "$ROOT/bin/moments-float"
    ;;
  debug)
    "${COMPILER}" -sdk "$SDK" -swift-version 5 -target "$TARGET" -Onone -parse-as-library \
      "$ROOT/MomentsFloat.swift" \
      -framework SwiftUI \
      -framework AppKit \
      -o "$ROOT/bin/moments-float"
    printf 'moments float: built %s\n' "$ROOT/bin/moments-float"
    ;;
  *)
    printf 'usage: %s [release|debug]\n' "$0" >&2
    exit 2
    ;;
esac
