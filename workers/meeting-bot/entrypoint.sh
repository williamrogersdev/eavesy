#!/bin/sh
# One bot per container: start the display, run the bot, exit with it.
set -e
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &
exec /usr/local/bin/eavesy-bot
