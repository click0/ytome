#!/bin/sh
# Пакування релізу: dist/ + усе потрібне для `npm ci --omit=dev` і запуску.
# Один скрипт і для CI, і для релізу — щоб архів, перевірений у CI, був тим самим.
#
#   sh scripts/package.sh 0.90.0 [out-dir]   → out-dir/ytome-0.90.0.tar.gz, .zip
set -eu

VERSION="$1"
OUT="${2:-release}"
NAME="ytome-${VERSION}"

test -d dist || { echo "dist/ missing — run npm run build first" >&2; exit 1; }

STAGE=$(mktemp -d)
mkdir -p "$STAGE/$NAME" "$OUT"
cp -R dist docs "$STAGE/$NAME/"
cp package.json package-lock.json .env.example LICENSE README.md CHANGELOG.md "$STAGE/$NAME/"

# Source maps і декларації в релізі не потрібні
find "$STAGE/$NAME/dist" \( -name '*.map' -o -name '*.d.ts' \) -delete

(cd "$STAGE" && tar -czf "$NAME.tar.gz" "$NAME" && zip -qr "$NAME.zip" "$NAME")
mv "$STAGE/$NAME.tar.gz" "$STAGE/$NAME.zip" "$OUT/"
rm -rf "$STAGE"
ls -l "$OUT/$NAME".*
