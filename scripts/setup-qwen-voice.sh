#!/bin/sh
# Compatibility entry point; setup itself is cross-platform.
exec node "$(dirname "$0")/setup-qwen-voice.mjs" "$@"
