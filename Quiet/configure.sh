#!/usr/bin/env bash
# Rewrites the bundle identifier prefix, App Group and team across the project.
#   ./configure.sh com.yourname.quiet TEAMID1234
set -euo pipefail

PREFIX="${1:?usage: ./configure.sh <bundle-prefix> [team-id]}"
TEAM="${2:-}"
OLD_PREFIX="com.example.quiet"
OLD_GROUP="group.${OLD_PREFIX}"
NEW_GROUP="group.${PREFIX}"

files=$(grep -rl --include='*.yml' --include='*.entitlements' --include='*.swift' --include='*.plist' --include='*.md' \
          -e "$OLD_PREFIX" . || true)
for f in $files; do
  sed -i.bak "s|${OLD_GROUP}|${NEW_GROUP}|g; s|${OLD_PREFIX}|${PREFIX}|g" "$f"
  rm -f "$f.bak"
done

if [ -n "$TEAM" ]; then
  sed -i.bak "s|DEVELOPMENT_TEAM: \"\"|DEVELOPMENT_TEAM: \"${TEAM}\"|" project.yml
  rm -f project.yml.bak
fi

echo "bundle prefix -> ${PREFIX}"
echo "app group     -> ${NEW_GROUP}"
[ -n "$TEAM" ] && echo "team          -> ${TEAM}"
echo "now run: xcodegen generate"
