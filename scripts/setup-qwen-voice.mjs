import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const backend = process.env.PWQ_VOICE_BACKEND || (process.platform === 'darwin' && process.arch === 'arm64' ? 'mlx' : 'torch');
if (!['mlx', 'torch'].includes(backend)) throw new Error('PWQ_VOICE_BACKEND must be mlx or torch');
if (backend === 'mlx' && (process.platform !== 'darwin' || process.arch !== 'arm64')) throw new Error('MLX voice requires Apple Silicon macOS; select torch on Windows/Linux.');
const environments = backend === 'mlx'
  ? [['.voice-venv', 'requirements-mlx.txt']]
  : [['.voice-asr-venv', process.platform==='win32'?'requirements-windows-asr.lock.txt':'requirements-asr.txt'],
     ['.voice-tts-venv', process.platform==='win32'?'requirements-windows-tts.lock.txt':'requirements-tts.txt']];
if(process.platform==='win32' && process.arch!=='x64') throw new Error('Windows voice currently requires x64 Node and Python 3.12. Windows ARM64 voice is not validated.');
function run(args) {
  const result = spawnSync('uv', args, {cwd: root, shell: false, stdio: 'inherit', windowsHide: true});
  if (result.error) throw new Error(`Cannot start uv. Install uv and reopen the terminal. ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Voice setup failed (exit ${result.status ?? result.signal}). Fix the reported error and rerun npm run voice:setup.`);
}
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({backend, environments}, null, 2));
} else {
  for (const [directory, requirements] of environments) {
    const python = path.join(root, directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (!fs.existsSync(python)) run(['venv', '--python', '3.12', path.join(root, directory)]);
    run(['pip', 'install', '--python', python, '-r', path.join(root, 'server', 'voice', requirements)]);
    run(['pip', 'check', '--python', python]);
  }
  console.log('Local voice dependencies installed. Model weights download on first use. GPU/CPU inference must be verified on the target machine.');
}
