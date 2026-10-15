#!/usr/bin/env python3
"""Persistent JSONL worker for local Qwen speech recognition and synthesis."""

from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import traceback
import wave
from pathlib import Path

import numpy as np

OUTPUT = sys.stdout
sys.stdout = sys.stderr  # Keep MLX/model diagnostics away from the JSONL protocol.
ASR_MODEL = os.environ.get("PRINCEQ_QWEN_ASR_MODEL", "")
TTS_MODEL = os.environ.get(
    "PRINCEQ_QWEN_TTS_MODEL", "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"
)
asr = None
tts = None


def get_asr():
    global asr
    if asr is None:
        from mlx_audio.stt import load

        model_ref = ASR_MODEL
        if not model_ref:
            local_model = Path.home() / "Documents/ChatGPT/Jev/models/qwen3-asr-1.7b-8bit"
            model_ref = str(local_model) if (local_model / "config.json").is_file() else "mlx-community/Qwen3-ASR-1.7B-8bit"
        asr = load(model_ref, lazy=False)
    return asr


def get_tts():
    global tts
    if tts is None:
        from mlx_audio.tts.utils import load_model

        tts = load_model(TTS_MODEL)
    return tts


def transcribe(audio_b64: str) -> dict[str, str]:
    audio = base64.b64decode(audio_b64, validate=True)
    if len(audio) > 8 * 1024 * 1024 or not (audio.startswith(b"RIFF") and audio[8:12] == b"WAVE"):
        raise ValueError("录音格式无效或文件过大，请重新录制。")
    with tempfile.NamedTemporaryFile(suffix=".wav") as wav:
        wav.write(audio)
        wav.flush()
        result = get_asr().generate(wav.name, language="Chinese", verbose=False)
    text = str(getattr(result, "text", "")).strip()
    if not text:
        raise ValueError("没有识别到语音，请再试一次。")
    return {"text": text[:8000]}


def synthesize(text: str) -> dict[str, str]:
    value = text.strip()
    if not value or len(value) > 2000:
        raise ValueError("需要朗读的文本为空或过长。")
    chunks = list(get_tts().generate_custom_voice(text=value, speaker="Vivian", language="Chinese"))
    if not chunks:
        raise RuntimeError("Qwen TTS 没有生成语音。")
    samples = np.concatenate([np.asarray(chunk.audio).reshape(-1) for chunk in chunks])
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with tempfile.NamedTemporaryFile(suffix=".wav") as wav_file:
        with wave.open(wav_file, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(int(getattr(chunks[0], "sample_rate", 24000)))
            wav.writeframes(pcm.tobytes())
        wav_file.seek(0)
        return {"audio_base64": base64.b64encode(wav_file.read()).decode("ascii")}


def main() -> None:
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            operation = request.get("op")
            if operation == "transcribe":
                result = transcribe(request["audio_base64"])
            elif operation == "synthesize":
                result = synthesize(request["text"])
            else:
                raise ValueError("未知语音操作。")
            response = {"id": request.get("id"), "ok": True, **result}
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            response = {"id": request.get("id"), "ok": False, "error": f"{type(exc).__name__}: {exc}"}
        OUTPUT.write(json.dumps(response, ensure_ascii=False) + "\n")
        OUTPUT.flush()


if __name__ == "__main__":
    main()
