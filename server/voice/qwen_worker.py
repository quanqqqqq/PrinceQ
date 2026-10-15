#!/usr/bin/env python3
"""Local Qwen JSONL worker: MLX on Apple Silicon; isolated PyTorch ASR/TTS elsewhere."""
from __future__ import annotations
import base64
import importlib.util
import io
import json
import os
import platform
import sys
import tempfile
import traceback
import wave
from pathlib import Path

BACKEND = os.environ.get('PWQ_VOICE_BACKEND', 'mlx' if sys.platform == 'darwin' and platform.machine() == 'arm64' else 'torch')
ASR_MODEL = os.environ.get('PRINCEQ_QWEN_ASR_MODEL', '')
TTS_MODEL = os.environ.get('PRINCEQ_QWEN_TTS_MODEL', '')
asr = None
tts = None


def probe(operation):
    if BACKEND not in ('mlx', 'torch'):
        return {'available': False, 'reason': 'PWQ_VOICE_BACKEND 必须为 mlx 或 torch。'}
    if BACKEND == 'mlx' and (sys.platform != 'darwin' or platform.machine() != 'arm64'):
        return {'available': False, 'reason': 'MLX 语音需要 Apple Silicon；此电脑请使用 torch 后端。'}
    packages = ['numpy', 'mlx_audio'] if BACKEND == 'mlx' else ['numpy', 'torch', 'qwen_asr' if operation == 'transcribe' else 'qwen_tts']
    missing = [name for name in packages if importlib.util.find_spec(name) is None]
    return {'available': not missing, 'reason': '本地语音依赖不完整，请运行 npm run voice:setup。' if missing else None}


def torch_options():
    import torch
    device = os.environ.get('PWQ_VOICE_DEVICE', 'cpu')
    if device != 'cpu' and not device.startswith('cuda'):
        raise ValueError('PWQ_VOICE_DEVICE 仅支持 cpu 或 cuda[:设备编号]。')
    if device.startswith('cuda') and not torch.cuda.is_available():
        raise RuntimeError('未检测到可用 CUDA，请安装匹配的 PyTorch/CUDA，或将 PWQ_VOICE_DEVICE 设置为 cpu。')
    return {'device_map': device, 'dtype': torch.float32 if device == 'cpu' else torch.float16, 'attn_implementation': 'eager'}


def get_asr():
    global asr
    if asr is None:
        if BACKEND == 'mlx':
            from mlx_audio.stt import load
            local = Path.home()/'Documents/ChatGPT/Jev/models/qwen3-asr-1.7b-8bit'
            model = ASR_MODEL or (str(local) if (local/'config.json').is_file() else 'mlx-community/Qwen3-ASR-1.7B-8bit')
            asr = load(model, lazy=False)
        elif BACKEND == 'torch':
            from qwen_asr import Qwen3ASRModel
            asr = Qwen3ASRModel.from_pretrained(ASR_MODEL or 'Qwen/Qwen3-ASR-0.6B', **torch_options(), max_inference_batch_size=1, max_new_tokens=512)
        else:
            raise ValueError('未知语音后端。')
    return asr


def get_tts():
    global tts
    if tts is None:
        if BACKEND == 'mlx':
            from mlx_audio.tts.utils import load_model
            tts = load_model(TTS_MODEL or 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit')
        elif BACKEND == 'torch':
            from qwen_tts import Qwen3TTSModel
            tts = Qwen3TTSModel.from_pretrained(TTS_MODEL or 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice', **torch_options())
        else:
            raise ValueError('未知语音后端。')
    return tts


def transcribe(audio_b64):
    audio = base64.b64decode(audio_b64, validate=True)
    if len(audio) > 8*1024*1024 or not (audio.startswith(b'RIFF') and audio[8:12] == b'WAVE'):
        raise ValueError('录音格式无效或文件过大，请重新录制。')
    # Close the file before a model/library opens it by name (required on Windows).
    with tempfile.TemporaryDirectory(prefix='princeq-voice-') as directory:
        filename = Path(directory)/'recording.wav'
        filename.write_bytes(audio)
        if BACKEND == 'mlx':
            result = get_asr().generate(str(filename), language='Chinese', verbose=False)
            text = str(getattr(result, 'text', '')).strip()
        else:
            results = get_asr().transcribe(audio=str(filename), language='Chinese')
            text = str(results[0].text if results else '').strip()
    if not text:
        raise ValueError('没有识别到语音，请再试一次。')
    return {'text': text[:8000]}


def synthesize(text):
    import numpy as np
    value = text.strip()
    if not value or len(value) > 2000:
        raise ValueError('需要朗读的文本为空或过长。')
    if BACKEND == 'mlx':
        chunks = list(get_tts().generate_custom_voice(text=value, speaker='Vivian', language='Chinese'))
        if not chunks:
            raise RuntimeError('Qwen TTS 没有生成语音。')
        samples = np.concatenate([np.asarray(chunk.audio).reshape(-1) for chunk in chunks])
        sample_rate = int(getattr(chunks[0], 'sample_rate', 24000))
    else:
        waves, sample_rate = get_tts().generate_custom_voice(text=value, speaker='Vivian', language='Chinese')
        if not waves:
            raise RuntimeError('Qwen TTS 没有生成语音。')
        samples = np.asarray(waves[0]).reshape(-1)
    pcm = (np.clip(samples, -1.0, 1.0)*32767).astype('<i2')
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(int(sample_rate))
        wav.writeframes(pcm.tobytes())
    return {'audio_base64': base64.b64encode(output.getvalue()).decode('ascii')}


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    output = sys.stdout
    sys.stdout = sys.stderr  # Model diagnostics must never enter JSONL responses.
    if '--probe' in sys.argv:
        output.write(json.dumps(probe(sys.argv[-1]), ensure_ascii=False)+'\n')
        output.flush()
        return
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            operation = request.get('op')
            if operation == 'transcribe':
                result = transcribe(request['audio_base64'])
            elif operation == 'synthesize':
                result = synthesize(request['text'])
            else:
                raise ValueError('未知语音操作。')
            response = {'id': request.get('id'), 'ok': True, **result}
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            response = {'id': request.get('id'), 'ok': False, 'error': f'{type(exc).__name__}: {exc}'}
        output.write(json.dumps(response, ensure_ascii=False)+'\n')
        output.flush()


if __name__ == '__main__':
    main()
