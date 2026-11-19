#!/bin/bash
# Builds resources/sip-helper.exe, the native engine of the SIP mode (Windows
# x64 only: the pjsua libraries are MSVC static libraries).
#
#   sh tools/build-native.sh
#
# The chain:
#
#   1. the static pjproject libraries with the msvc-wine container, only when
#      they are missing from native/sip-engine/third_party (they are big and
#      gitignored),
#   2. the helper with cargo-xwin.
#
# The tools it needs on the machine:
#   - cargo, the target x86_64-pc-windows-msvc and cargo-xwin
#   - docker with the image msvc-wine:local (call center project)
#
# PJPROJECT_TREE  the patched pjproject tree
#                 (default /home/momar/apps/call-center-project/MicroSIP-3.22.16-src)

set -e

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
PJ="$ROOT/native/sip-engine/third_party/pjproject-win-x64"
TREE=${PJPROJECT_TREE:-/home/momar/apps/call-center-project/MicroSIP-3.22.16-src}
IMAGE=${MSVC_IMAGE:-msvc-wine:local}
PREFIX=${WINEPREFIX_DIR:-$HOME/.cache/msvc-wine-prefix}

if [ ! -f "$PJ/lib/libpjproject-x64-Win32-vc14-Release-Static.lib" ] \
    || [ ! -f "$PJ/include/pjlib/include/pj/config_site.h" ]; then
    echo "== 1. pjproject for windows x64 (the msvc-wine container)"
    mkdir -p "$PREFIX"
    docker run --rm --security-opt label=disable \
        --user "$(id -u):$(id -g)" \
        -e HOME=/tmp/h \
        -e WINEPREFIX=/wine \
        -v "$PREFIX:/wine" \
        -v "$TREE:/work/microsip" \
        -v "$ROOT:/work/glmwebrtc" \
        "$IMAGE" \
        bash -c 'bash /work/glmwebrtc/tools/build-pjproject-x64.sh \
            --tree /work/microsip \
            --out /work/glmwebrtc/native/sip-engine/third_party/pjproject-win-x64'
else
    echo "== 1. pjproject for windows x64: already built"
fi

echo
echo "== 2. the helper"
cd "$ROOT/native"
cargo xwin build --release --target x86_64-pc-windows-msvc -p sip-helper

mkdir -p "$ROOT/resources"
cp "$ROOT/native/target/x86_64-pc-windows-msvc/release/sip-helper.exe" \
    "$ROOT/resources/sip-helper.exe"
echo
echo "== done: resources/sip-helper.exe"
