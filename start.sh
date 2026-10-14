#!/bin/bash
# Rally — production start
cd "$(dirname "$0")"
export PORT=${PORT:-3000}
export COOKIE_SECURE=${COOKIE_SECURE:-0}
exec node server/index.js
