#!/bin/sh
cd "$(dirname "$0")"
if [ -x /opt/homebrew/bin/npm ]; then
  /opt/homebrew/bin/npm run start:all
else
  npm run start:all
fi
