"""No downloads, real models, credentials, or installations in the user's home."""
import base64
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
import wave

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT/relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load('installer', 'skill/scripts/install_skill.py')
worker = load('worker', 'server/voice/qwen_worker.py')


class InstallerTests(unittest.TestCase):
    def test_copy_install_update_and_refuse_unmanaged_directory(self):
        with tempfile.TemporaryDirectory(prefix='PrinceQ 中文 空格-') as directory:
            root = Path(directory)
            source, destination = root/'source', root/'installed'
            source.mkdir()
            (source/'SKILL.md').write_text('第一版', encoding='utf-8')
            installer.install(source, destination, 'copy')
            self.assertFalse(destination.is_symlink())
            self.assertEqual((destination/'SKILL.md').read_text(encoding='utf-8'), '第一版')
            (source/'SKILL.md').write_text('第二版', encoding='utf-8')
            installer.install(source, destination, 'copy')
            self.assertEqual((destination/'SKILL.md').read_text(encoding='utf-8'), '第二版')
            (destination/installer.MARKER).unlink()
            with self.assertRaises(ValueError):
                installer.install(source, destination, 'copy')
            self.assertEqual((destination/'SKILL.md').read_text(encoding='utf-8'), '第二版')

    def test_failed_update_restores_previous_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source';source.mkdir();destination=root/'installed'
            (source/'SKILL.md').write_text('old')
            installer.install(source,destination,'copy')
            (source/'SKILL.md').write_text('new')
            rename=Path.rename
            def fail_staged(file,target):
                if file.name == 'skill':
                    raise PermissionError('simulated file lock')
                return rename(file,target)
            with patch.object(Path,'rename',fail_staged):
                with self.assertRaises(PermissionError):installer.install(source,destination,'copy')
            self.assertEqual((destination/'SKILL.md').read_text(),'old')


class ClientProtocolTests(unittest.TestCase):
    def test_cli_write_uses_preview_transport_and_preserves_unicode(self):
        client=load('portable_client', 'skill/scripts/pwq_client.py')
        calls=[]
        def request(base,method,path,body=None,query=None,key=None):
            calls.append((method,path,body))
            if method=='GET' and path=='/api/skills/princeq':
                return {'operations':[{'name':'task.create','method':'POST','path':'/api/tasks'}]}
            return {'token':'pending-123'}
        with patch.object(client,'request',request),patch.object(client,'emit'):
            client.main(['create-task','中文任务'])
        self.assertEqual([path for method,path,body in calls if method=='POST'],['/api/skills/princeq/previews'])
        self.assertEqual(calls[-1][2]['actions'][0]['payload']['title'],'中文任务')

    def test_confirmation_requires_explicit_flag_before_any_request(self):
        client=load('portable_confirmation', 'skill/scripts/pwq_client.py')
        with patch.object(client,'request') as request,patch.object(sys,'stderr',io.StringIO()):
            with self.assertRaises(SystemExit) as error:client.main(['agent-preview','confirm','pending'])
        self.assertEqual(error.exception.code,2);request.assert_not_called()

    def test_copied_skill_client_matches_source(self):
        with tempfile.TemporaryDirectory() as directory:
            destination=Path(directory)/'installed'
            installer.install(ROOT/'skill',destination,'copy')
            self.assertEqual((destination/'scripts/pwq_client.py').read_bytes(),(ROOT/'skill/scripts/pwq_client.py').read_bytes())


class VoiceTests(unittest.TestCase):
    def recording(self):
        output=io.BytesIO()
        with wave.open(output,'wb') as wav:
            wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(b'\0\0'*32)
        return base64.b64encode(output.getvalue()).decode('ascii')

    def test_torch_transcription_reopens_closed_file_and_cleans_it(self):
        opened=[]
        def transcribe(audio,language):
            file=Path(audio)
            with file.open('rb') as stream:self.assertEqual(stream.read(4),b'RIFF')
            # Windows cannot delete/reopen an ordinary locked temporary file.
            moved=file.with_suffix('.moved');file.rename(moved);moved.rename(file)
            opened.append(file)
            return [Mock(text='中文识别结果')]
        with patch.object(worker,'BACKEND','torch'),patch.object(worker,'get_asr',return_value=Mock(transcribe=transcribe)):
            self.assertEqual(worker.transcribe(self.recording()),{'text':'中文识别结果'})
        self.assertTrue(opened);self.assertFalse(opened[0].exists())

    def test_mlx_contract_and_error_cleanup_are_preserved(self):
        files=[]
        def fail(filename,**kwargs):
            files.append(Path(filename));raise RuntimeError('inference failed')
        with patch.object(worker,'BACKEND','mlx'),patch.object(worker,'get_asr',return_value=Mock(generate=fail)):
            with self.assertRaises(RuntimeError):worker.transcribe(self.recording())
        self.assertFalse(files[0].exists())

    def test_probe_loads_no_model_and_reports_missing_packages(self):
        with patch.object(worker,'BACKEND','torch'),patch.object(worker.importlib.util,'find_spec',return_value=None):
            self.assertFalse(worker.probe('transcribe')['available'])
        with patch.object(worker,'BACKEND','invalid'):
            self.assertFalse(worker.probe('transcribe')['available'])

    def test_cpu_is_float32_and_cuda_is_explicit(self):
        torch=Mock(float32='fp32',float16='fp16');torch.cuda.is_available.return_value=False
        with patch.dict(sys.modules,{'torch':torch}),patch.dict(worker.os.environ,{'PWQ_VOICE_DEVICE':'cpu'}):
            self.assertEqual(worker.torch_options(),{'device_map':'cpu','dtype':'fp32','attn_implementation':'eager'})
        with patch.dict(sys.modules,{'torch':torch}),patch.dict(worker.os.environ,{'PWQ_VOICE_DEVICE':'cuda:0'}):
            with self.assertRaises(RuntimeError):worker.torch_options()

    def test_torch_factories_use_documented_defaults_without_loading_weights(self):
        asr_factory=Mock();tts_factory=Mock()
        with patch.object(worker,'BACKEND','torch'),patch.object(worker,'asr',None),patch.object(worker,'tts',None),patch.object(worker,'ASR_MODEL',''),patch.object(worker,'TTS_MODEL',''),patch.object(worker,'torch_options',return_value={'device_map':'cpu'}),patch.dict(sys.modules,{'qwen_asr':Mock(Qwen3ASRModel=asr_factory),'qwen_tts':Mock(Qwen3TTSModel=tts_factory)}):
            worker.get_asr();worker.get_tts()
        self.assertEqual(asr_factory.from_pretrained.call_args.args[0],'Qwen/Qwen3-ASR-0.6B')
        self.assertEqual(tts_factory.from_pretrained.call_args.args[0],'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice')
        self.assertEqual(asr_factory.from_pretrained.call_args.kwargs['max_inference_batch_size'],1)

    def test_torch_tts_produces_a_valid_in_memory_wave(self):
        class Samples:
            def reshape(self,*args):return self
            def __mul__(self,other):return self
            def astype(self,dtype):return self
            def tobytes(self):return b'\0\0'*16
        samples=Samples();numpy=Mock();numpy.asarray.return_value=samples;numpy.clip.return_value=samples
        tts=Mock();tts.generate_custom_voice.return_value=([samples],24000)
        with patch.object(worker,'BACKEND','torch'),patch.object(worker,'get_tts',return_value=tts),patch.dict(sys.modules,{'numpy':numpy}):
            result=worker.synthesize('你好')
        with wave.open(io.BytesIO(base64.b64decode(result['audio_base64'])),'rb') as wav:
            self.assertEqual(wav.getframerate(),24000);self.assertEqual(wav.getnframes(),16)
        self.assertEqual(tts.generate_custom_voice.call_args.kwargs,{'text':'你好','speaker':'Vivian','language':'Chinese'})

    def test_worker_jsonl_unicode_and_invalid_input_are_structured(self):
        result=subprocess.run([sys.executable,str(ROOT/'server/voice/qwen_worker.py')],input=json.dumps({'id':'中文','op':'unknown'},ensure_ascii=False)+'\n',encoding='utf-8',capture_output=True,check=True)
        reply=json.loads(result.stdout)
        self.assertEqual(reply['id'],'中文');self.assertFalse(reply['ok']);self.assertIn('未知',reply['error'])


if __name__ == '__main__':unittest.main()
