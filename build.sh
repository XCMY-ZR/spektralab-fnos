#!/bin/bash
#
# build.sh — assemble `fnos/app/` from a built SpektraLab checkout, then pack
# `spektralab.fpk`.
#
# This repository holds the *packaging* project only. The engine and the
# interface are built in the SpektraLab checkout, and the three build outputs
# are assembled here rather than edited in place:
#
#   $SRC/build/linux/engine/host/spektralab-host    the C++/Vulkan engine
#   $SRC/build/linux/engine/resources/vulkan/       the compiled compute kernels
#   $SRC/desktop/dist/                              the built interface
#
# `$SRC/engine/resources/` (spektrafilm's baked data) and
# `$SRC/engine/resources_product/` (the four black-and-white films and the
# silver paper) are tracked in the SpektraLab repository and laid into
# `fnos/app/host/engine/` here.
#
# SRC defaults to the layout it finds: this tree's parent if that is a
# SpektraLab checkout (the packaging tree inside the checkout, and the source
# archive attached to a release), otherwise a sibling checkout `../SpektraLab`.
#
#   SRC=/path/to/SpektraLab ./build.sh
#
# Requires `fnpack` on PATH.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

SRC=${SRC:-}
if [[ -z $SRC ]]; then
  if [[ -d ../engine/resources ]]; then
    SRC=..                     # this tree sits inside a SpektraLab checkout
  else
    SRC=../SpektraLab          # a sibling checkout
  fi
fi
HOST=${HOST:-$SRC/build/linux/engine/host/spektralab-host}
SHADERS=${SHADERS:-$SRC/build/linux/engine/resources/vulkan}
DIST=${DIST:-$SRC/desktop/dist}
RESOURCES=${RESOURCES:-$SRC/engine/resources}
PRODUCT=${PRODUCT:-$SRC/engine/resources_product}
APP=fnos/app

if [[ ! -d $SRC/engine/resources ]]; then
  echo "build.sh: SRC=$SRC does not look like a SpektraLab checkout" >&2
  echo "    (no $SRC/engine/resources)" >&2
  exit 1
fi
if [[ ! -x $HOST ]]; then
  echo "build.sh: $HOST is missing or not executable" >&2
  echo "    build it:  (cd $SRC && engine/build-linux.sh)" >&2
  exit 1
fi
if [[ ! -f $DIST/index.html ]]; then
  echo "build.sh: $DIST/index.html is missing" >&2
  echo "    build it:  (cd $SRC/desktop && npm ci && npm run build:web)" >&2
  exit 1
fi
if ! command -v fnpack >/dev/null 2>&1; then
  echo "build.sh: fnpack is not on PATH" >&2
  exit 1
fi

# The two generated trees are gitignored, so a fresh clone has neither: `install`
# into a missing directory fails with "No such file or directory" rather than
# creating it.
mkdir -p "$APP/host" "$APP/server"

# 1. The engine binary. `install` sets 755: the compiler leaves it mode 000.
install -m 755 "$HOST" "$APP/host/spektralab-host"

# 2. spektrafilm's baked data, then the two things that live beside it:
#    the compiled kernels, and the product's own profiles. The notice travels
#    with the profiles (it is the only record of what they are built from).
# `--chmod` is not decoration: the checkout this runs from may report its
# directories as mode 000 (a network mount can), and rsync -a would copy
# that, leaving the engine tree unreadable to everything that follows.
rsync -a --delete --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
  --exclude=PRODUCT_PROFILES_NOTICE.md "$RESOURCES/" "$APP/host/engine/"
rsync -a --delete --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r "$SHADERS/" "$APP/host/engine/vulkan/"
cp -f "$PRODUCT"/profiles/*.json "$APP/host/engine/profiles/"
cp -f "$PRODUCT/NOTICE.md" "$APP/host/engine/PRODUCT_PROFILES_NOTICE.md"

# 3. The silver paper's neutral pack. `engine/resources/neutral_print_filters.json`
#    is spektrafilm's and has no row for a paper it does not know; the product's
#    row is the Multigrade grade-2 pack (0, 0, 68). The macOS app sends those
#    three numbers on the wire (`Params.multigradeFilter2`); the web interface
#    does not, so the engine's own table has to carry them or a black-and-white
#    print comes out about 0.36 D light at roughly grade 3½. Merged here, not
#    edited into the tracked file, because `engine/resources/` is upstream's.
python3 - "$APP/host/engine/neutral_print_filters.json" "$PRODUCT/neutral_print_filters.json" <<'PY'
import json, sys

target, product_path = sys.argv[1], sys.argv[2]
with open(target) as f:
    base = json.load(f)
with open(product_path) as f:
    product = json.load(f)
added = [k for k in product if k not in base]
base.update(product)
with open(target, "w") as f:
    json.dump(base, f, indent=4)
    f.write("\n")
print(f"    neutral pack: +{', '.join(added) if added else 'nothing'}")
PY

# 4. The interface.
rsync -a --delete --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r "$DIST/" "$APP/server/web/"

# 5. Permissions. `fnpack` refuses nothing, but a 000 file installs as a 000
#    file: the app then fails to read its own resources. `cp -a` of a build
#    output is the usual way this happens.
find fnos -type d -exec chmod 755 {} +
find fnos -type f -exec chmod 644 {} +
chmod 755 fnos/cmd/main "$APP/host/spektralab-host"
unreadable=$(find fnos -type f ! -perm -004 | wc -l)
if [[ $unreadable -ne 0 ]]; then
  echo "build.sh: $unreadable files are unreadable" >&2
  find fnos -type f ! -perm -004 | head >&2
  exit 1
fi

# 6. Pack.
rm -f spektralab.fpk
fnpack build --directory fnos
chmod 644 spektralab.fpk
echo
echo "spektralab.fpk $(stat -c %s spektralab.fpk) bytes"
sha256sum spektralab.fpk
