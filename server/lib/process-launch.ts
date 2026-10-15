/** Launch native binaries and npm JavaScript entries without a command shell. */
import fs from 'node:fs';
import path from 'node:path';
import {spawn, type ChildProcess} from 'node:child_process';

export interface Launch {executable: string; args: string[]}
const activeChildren = new Set<ChildProcess>();

export function trackRuntimeProcess<T extends ChildProcess>(child: T): T {
  activeChildren.add(child);
  child.once('close', () => activeChildren.delete(child));
  child.once('error', () => { if (!child.pid) activeChildren.delete(child); });
  return child;
}

export function stopRuntimeProcesses(): void {
  for (const child of activeChildren) terminateProcessTree(child, 'SIGKILL');
}

export function resolveCliLaunch(executable: string, args: string[], platform: NodeJS.Platform = process.platform): Launch {
  if (platform !== 'win32') {
    try {
      const entry = fs.realpathSync(executable);
      if (/\.[cm]?js$/i.test(entry)) return {executable: process.execPath, args: [entry, ...args]};
    } catch { /* Let spawn report missing files in its normal result shape. */ }
  }
  if (/\.[cm]?js$/i.test(executable)) return {executable: process.execPath, args: [executable, ...args]};
  if (platform !== 'win32' || !/\.(cmd|bat|ps1)$/i.test(executable)) return {executable, args};
  const basename = path.basename(executable).replace(/\.(cmd|bat|ps1)$/i, '').toLowerCase();
  const packages: Record<string, string> = {codex: '@openai/codex', claude: '@anthropic-ai/claude-code'};
  const packageName = packages[basename];
  if (packageName) {
    // npm places its Windows shims beside node_modules. Never execute/parse shell text.
    const directories = [path.join(path.dirname(executable), 'node_modules', packageName)];
    if (path.basename(path.dirname(executable)) === '.bin') directories.push(path.join(path.dirname(executable), '..', packageName));
    for (const directory of directories) try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[basename];
      if (manifest.name === packageName && typeof relative === 'string') {
        const entry = fs.realpathSync(path.resolve(directory, relative));
        const root = fs.realpathSync(directory);
        const within = path.relative(root, entry);
        if (within && !within.startsWith('..' + path.sep) && within !== '..' && !path.isAbsolute(within) &&
            /\.[cm]?js$/i.test(entry) && fs.statSync(entry).isFile()) {
          return {executable: process.execPath, args: [entry, ...args]};
        }
      }
    } catch { /* Try the other documented npm layout, then fail closed. */ }
  }
  throw new Error('无法安全启动此 Windows 脚本入口，请选择原生 .exe，或重新安装官方 npm 版 Claude/Codex CLI 后检测。');
}

/** POSIX executability bits do not describe Windows executable formats. */
export function executableFile(file: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform === 'win32') {
      if (!/\.(exe|com|cmd|bat|ps1|[cm]?js)$/i.test(file)) return false;
      resolveCliLaunch(file, [], platform);
    } else {
      fs.accessSync(file, /\.[cm]?js$/i.test(file) ? fs.constants.R_OK : fs.constants.X_OK);
    }
    return true;
  } catch { return false; }
}

/** Every CLI is started in its own POSIX group; Windows uses taskkill's tree mode. */
export function terminateProcessTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot) { child.kill('SIGKILL'); return; }
    const killer = spawn(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'],
      {shell: false, windowsHide: true, stdio: 'ignore'});
    killer.once('error', () => { try {child.kill('SIGKILL');} catch { /* Already gone. */ } });
    killer.once('exit', code => { if (code) {try {child.kill('SIGKILL');} catch { /* Already gone. */ }} });
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch { try {child.kill(signal);} catch { /* Already gone. */ } }
}
