#!/bin/sh
set -eu
umask 077
mkdir -p "$HOME/.config/opencode/router" "$HOME/.omo"
# Seed only a new isolated HOME; never overwrite an existing configuration.
if [ ! -e "$HOME/.config/opencode/opencode.jsonc" ]; then
  cp /opt/bundle/config/opencode.jsonc "$HOME/.config/opencode/opencode.jsonc"
fi
if [ ! -e "$HOME/.omo/omo.jsonc" ]; then
  cp /opt/bundle/config/omo.jsonc "$HOME/.omo/omo.jsonc"
fi
for file in subscription-router.js provider-error-normalizer.js orchestration.md; do
  if [ ! -e "$HOME/.config/opencode/router/$file" ]; then
    cp "/opt/bundle/router/$file" "$HOME/.config/opencode/router/$file"
  fi
done
exec opencode "$@"
