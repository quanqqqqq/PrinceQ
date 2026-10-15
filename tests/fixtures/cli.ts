/** Real child processes, with JavaScript bodies so fixtures need no platform shell. */
import fs from 'node:fs';
import path from 'node:path';

export function nodeCli(file: string, body: string, version = false): string {
  const target = file.replace(/\.sh$/, '') + '.cjs';
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, (version ? "if(process.argv.includes('--version')){console.log('fake-cli 1.0.0');process.exit(0);}\n" : '') + body);
  return target;
}

export function discoverableCli(directory: string, name: string, body: string): string {
  fs.mkdirSync(directory, {recursive: true});
  if (process.platform === 'win32' && ['claude', 'codex'].includes(name)) {
    const packageName = name === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex';
    const root = path.join(directory, 'node_modules', packageName);
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: packageName, bin: {[name]: 'cli.cjs'}}));
    fs.writeFileSync(path.join(root, 'cli.cjs'), body);
    const shim = path.join(directory, name + '.cmd');
    fs.writeFileSync(shim, '@echo off\r\nrem Never executed by PrinceQ\r\nexit /b 97\r\n');
    return shim;
  }
  const target = path.join(directory, name);
  const entry = target + '.cjs';
  fs.writeFileSync(entry, body, {mode: 0o755});
  fs.symlinkSync(entry, target);
  return target;
}
