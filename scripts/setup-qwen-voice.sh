#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required to create the isolated local Qwen voice environment." >&2
  exit 1
fi

if [ ! -x .voice-venv/bin/python ]; then
  uv venv --python 3.12 .voice-venv
fi
uv pip install --python .voice-venv/bin/python \
  'mlx-audio==0.5.6' 'mlx-lm==0.31.3' 'numpy==2.5.3'

echo "Local Qwen voice runtime is ready. The ASR and TTS weights download on first use."
