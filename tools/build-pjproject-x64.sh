#!/bin/bash
# Builds pjproject for windows x64 with cl.exe and drops the result where the
# rust crate of the softphone expects it.
#
#   sh tools/build-pjproject-x64.sh [--tree <pjproject tree>] [--out <dir>]
#
# It runs inside the msvc-wine container, the compiler comes from /opt/msvc.
# The tree is the one of the call center project, it is already patched with
# the G.729 (bcg729) and the opus codecs.
#
# The result:
#   <out>/lib/libpjproject-x64-Win32-vc14-Release-Static.lib
#   <out>/lib/bcg729.lib
#   <out>/lib/opus.lib
#   <out>/include/...        the headers the bindings are made from

set -e

TREE=""
OUT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --tree) TREE=$2; shift 2 ;;
        --tree=*) TREE=${1#--tree=}; shift ;;
        --out) OUT=$2; shift 2 ;;
        --out=*) OUT=${1#--out=}; shift ;;
        *) shift ;;
    esac
done

HERE=$(cd "$(dirname "$0")" && pwd)
if [ -z "$TREE" ]; then
    TREE=${PJPROJECT_TREE:-/work/microsip}
fi
if [ -z "$OUT" ]; then
    OUT=${PJPROJECT_OUT:-/work/phonebar/crates/sip-engine/third_party/pjproject-win-x64}
fi
TREE=$(cd "$TREE" && pwd)
TP="$TREE/third_party"
OBJ="$TREE/out/x64"

# the compiler, the x64 one. The path of the container has the x86 tools
# first, the objects would be 32 bit.
export PATH="/opt/msvc/bin/x64:$PATH"
if [ -f /opt/msvc/bin/x64/msvcenv.sh ]; then
    . /opt/msvc/bin/x64/msvcenv.sh
fi

mkdir -p "$OBJ" "$OUT/lib" "$OUT/include"

# --- the projects of pjproject ------------------------------------------------
PROJECTS="pjlib/build/pjlib.vcxproj
pjlib-util/build/pjlib_util.vcxproj
pjmedia/build/pjmedia_audiodev.vcxproj
pjmedia/build/pjmedia_codec.vcxproj
pjmedia/build/pjmedia.vcxproj
pjmedia/build/pjmedia_videodev.vcxproj
pjnath/build/pjnath.vcxproj
pjsip/build/pjsip_core.vcxproj
pjsip/build/pjsip_simple.vcxproj
pjsip/build/pjsip_ua.vcxproj
pjsip/build/pjsua2_lib.vcxproj
pjsip/build/pjsua_lib.vcxproj
third_party/build/baseclasses/libbaseclasses.vcxproj
third_party/build/g7221/libg7221codec.vcxproj
third_party/build/gsm/libgsmcodec.vcxproj
third_party/build/ilbc/libilbccodec.vcxproj
third_party/build/milenage/libmilenage.vcxproj
third_party/build/resample/libresample.vcxproj
third_party/build/speex/libspeex.vcxproj
third_party/build/srtp/libsrtp.vcxproj
third_party/build/webrtc/libwebrtc.vcxproj
third_party/build/yuv/libyuv.vcxproj"

echo "== 1. pjproject"
rm -f "$OBJ/libs.txt" || true
for p in $PROJECTS; do
    name=$(basename "$p" .vcxproj)
    echo "-- $name"
    # The G.729 codec of pjmedia is guarded by PJMEDIA_HAS_BCG729, the tree
    # defines PJMEDIA_HAS_BCG729_CODEC, so the codec would never be
    # registered. BCG729_STATIC is the import of the static library of
    # bcg729, without it the symbols are wanted in a dll.
    DEFINE=""
    if [ "$name" = "pjmedia_codec" ]; then
        DEFINE="--define PJMEDIA_HAS_BCG729=1 --define BCG729_STATIC=1"
    fi
    python3 "$HERE/msvc_build.py" --project "$TREE/$p" \
        --configuration "Release-Static" --platform "x64" \
        --out "$OBJ/$name.lib" --objdir "$OBJ/obj/$name" $DEFINE
    echo "$OBJ/$name.lib" >> "$OBJ/libs.txt"
done

echo
echo "== 2. the combined library"
python3 "$HERE/msvc_build.py" --project "$TREE/pjsip-apps/build/libpjproject.vcxproj" \
    --configuration "Release-Static" --platform "x64" \
    --out "$OUT/lib/libpjproject-x64-Win32-vc14-Release-Static.lib" \
    --objdir "$OBJ/obj/libpjproject" \
    --merge $(cat "$OBJ/libs.txt")

# --- the codecs ---------------------------------------------------------------
# opus: the source list comes from the makefiles of opus
echo
echo "== 3. opus"
python3 "$HERE/build-opus.py" "$TP/opus" "$OUT/lib/opus.lib" --objdir "$OBJ/opus"
cp "$OUT/lib/opus.lib" "$OUT/lib/libopus.a"

# bcg729: the G.729 codec of pjmedia
echo
echo "== 4. bcg729 (G.729)"
mkdir -p "$OBJ/bcg729"
OBJS=""
for src in "$TP"/bcg729/src/*.c; do
    obj="$OBJ/bcg729/$(basename "$src" | sed 's/\.[^.]*$//').obj"
    cl /nologo /c /MT /O2 /W3 /DBCG729_STATIC=1 "/I$(printf 'Z:%s' "$TP/bcg729/include" | sed 's|/|\\|g')" \
       "/Fo$(printf 'Z:%s' "$obj" | sed 's|/|\\|g')" \
       "$(printf 'Z:%s' "$src" | sed 's|/|\\|g')"
    OBJS="$OBJS $obj"
done
lib /nologo "/OUT:$(printf 'Z:%s' "$OUT/lib/bcg729.lib" | sed 's|/|\\|g')" \
    $(for o in $OBJS; do printf 'Z:%s ' "$(printf '%s' "$o" | sed 's|/|\\|g')"; done)

# --- the headers --------------------------------------------------------------
echo
echo "== 5. the headers"
for d in pjlib/include pjlib-util/include pjmedia/include pjnath/include pjsip/include; do
    mkdir -p "$OUT/include/$(dirname $d)"
    cp -r "$TREE/$d" "$OUT/include/$d"
done
# a few headers live in the sources of pjmedia and pjsip
mkdir -p "$OUT/include/pjmedia/src" "$OUT/include/pjsip/src"
cp -r "$TREE/pjmedia/src/pjmedia" "$OUT/include/pjmedia/src/pjmedia"
cp -r "$TREE/pjsip/src/pjsip" "$OUT/include/pjsip/src/pjsip"

echo
echo "== done"
ls -la "$OUT/lib"
