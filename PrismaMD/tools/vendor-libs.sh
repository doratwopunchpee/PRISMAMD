#!/usr/bin/env sh
# Bundles three.js (+ MMD addons, ammo.js physics) and JSZip into the app so it runs fully offline.
# Run once on a computer with Node/npm, then rebuild the APK. Without it the app loads the same
# pinned versions from the jsDelivr CDN at first launch.
set -eu

THREE_VERSION=0.160.0
JSZIP_VERSION=3.10.1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/app/src/main/assets/www/lib"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"
npm pack "three@$THREE_VERSION" "jszip@$JSZIP_VERSION" >/dev/null
mkdir three jszip
tar xzf "three-$THREE_VERSION.tgz" -C three --strip-components=1
tar xzf "jszip-$JSZIP_VERSION.tgz" -C jszip --strip-components=1

rm -rf "$DEST"
mkdir -p "$DEST/three/build" "$DEST/three/examples/jsm"
cp three/build/three.module.js "$DEST/three/build/"
for d in controls loaders animation effects libs shaders; do
  cp -r "three/examples/jsm/$d" "$DEST/three/examples/jsm/"
done
cp jszip/dist/jszip.min.js "$DEST/"

echo "Vendored three@$THREE_VERSION and jszip@$JSZIP_VERSION into $DEST"
