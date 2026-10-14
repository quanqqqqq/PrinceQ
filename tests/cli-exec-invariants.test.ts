/**
 * `cli-exec.ts` 新执行链路的隔离测试。
 *
 * 守住修掉「Claude/Codex 非交互不返回」那几条根因：
 *  1. **stdin 永远 EOF**：不传 input 时 stdin 接 `/dev/null`，子进程一读就结束——
 *     这正是 `codex exec "..."` 在非 TTY 下仍「Reading additional input from stdin」
 *     挂死的对症修复。
 *  2. **安全 env**：基础白名单（HOME/PATH/...）自动继承；危险变量（NODE_OPTIONS 等）
 *     即便点名也不透传。
 *  3. **provider 固定形状 + cfg.args 去重**：用户 args 里再写 `--output-format` 这类
 *     已被硬编码拥有的 flag（连同其值）一律丢弃，避免后写覆盖前写。
 *
 * 全程假 CLI、离线、不碰真实 claude/codex、不写真实配置与库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { buildProviderPromptArgs, runCli } = await import('../server/agent/cli-exec.ts');
const { ROOT_DIR } = await import('../server/config.ts');

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-cli-exec-bin-'));

function fakeCli(name: string, body: string): string {
  const file = path.join(binDir, name);
  fs.writeFileSync(
    file,
    ['#!/bin/sh', 'for a in "$@"; do [ "$a" = "--version" ] && { echo v; exit 0; }; done', body].join(
      '\n',
    ),
    { mode: 0o755 },
  );
  return file;
}

test('stdin 默认 EOF：子进程 read 立刻结束，不等输入（codex 挂死回归）', async () => {
  const cli = fakeCli(
    'stdin_eof.sh',
    // stdin 是 /dev/null 时 `read` 立即失败；若是一个开着的 pipe/TTY，它会一直等到超时。
    'if read -r line; then echo "GOT:${line}"; else echo "STDIN_EOF"; fi',
  );
  const r = await runCli({ executable: cli, args: [], cwd: ROOT_DIR, envNames: [], timeoutMs: 5000 });
  assert.equal(r.exitCode, 0, `应正常退出：${r.stderr}`);
  assert.equal(r.timedOut, false, '绝不能因为等 stdin 而超时');
  assert.match(r.stdout, /STDIN_EOF/, 'stdin 必须是立刻 EOF，而不是开着的输入流');
});

test('input 文本：通过 pipe 写入并立刻 end，子进程能读到', async () => {
  const cli = fakeCli('stdin_echo.sh', 'cat');
  const r = await runCli({
    executable: cli,
    args: [],
    cwd: ROOT_DIR,
    envNames: [],
    timeoutMs: 5000,
    input: 'HELLO_STDIN_PWQ',
  });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /HELLO_STDIN_PWQ/, 'input 应被写入子进程 stdin');
});

test('安全 env：HOME 等基础变量自动继承；危险变量即便点名也绝不透传', async () => {
  process.env.NODE_OPTIONS = '--require=/tmp/pwn.js';
  process.env.DYLD_INSERT_LIBRARIES = '/tmp/x.dylib';
  process.env.PWQ_OK_MARKER = 'yes';
  try {
    const cli = fakeCli(
      'envprobe.sh',
      [
        '[ -n "$NODE_OPTIONS" ] && echo "NODE_OPTIONS_LEAK"',
        '[ -n "$DYLD_INSERT_LIBRARIES" ] && echo "DYLD_LEAK"',
        '[ -n "$PWQ_OK_MARKER" ] && echo "OK_PRESENT"',
        '[ -n "$HOME" ] && echo "HOME_PRESENT"',
        '[ -n "$PATH" ] && echo "PATH_PRESENT"',
      ].join('\n'),
    );
    const r = await runCli({
      executable: cli,
      args: [],
      cwd: ROOT_DIR,
      // 用户白名单里故意点名危险变量——denylist 仍要拦下；合法变量照常透传。
      envNames: ['PWQ_OK_MARKER', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES'],
      timeoutMs: 5000,
    });
    assert.doesNotMatch(r.stdout, /NODE_OPTIONS_LEAK/, 'NODE_OPTIONS 绝不能透传');
    assert.doesNotMatch(r.stdout, /DYLD_LEAK/, 'DYLD_INSERT_LIBRARIES 即便点名也拦下');
    assert.match(r.stdout, /OK_PRESENT/, '合法白名单变量应传入');
    assert.match(r.stdout, /HOME_PRESENT/, 'HOME 是基础安全变量，应自动继承（CLI 找登录态用）');
    assert.match(r.stdout, /PATH_PRESENT/, 'PATH 必须给');
  } finally {
    delete process.env.NODE_OPTIONS;
    delete process.env.DYLD_INSERT_LIBRARIES;
    delete process.env.PWQ_OK_MARKER;
  }
});

test('cfg.args 去重：用户重复声明硬编码拥有的 flag（含其值）被丢弃', () => {
  const args = buildProviderPromptArgs('claude', 'Q', {
    model: null,
    // 用户 args 里又塞了一次 --output-format（冲突）和一个安全的额外参数。
    args: ['--output-format', 'json', '--extra-safe', '--permission-prompts', 'host'],
  });
  // --output-format 只能出现一次，且是硬编码的 text。
  const idx = args.indexOf('--output-format');
  assert.ok(idx >= 0);
  assert.equal(args[idx + 1], 'text', '硬编码的 text 胜出');
  assert.ok(!args.includes('json'), '用户冲突的 --output-format json 必须被丢弃');
  assert.ok(!args.includes('host'), '冲突 flag 的值也必须被丢弃');
  assert.ok(args.includes('--extra-safe'), '非冲突的安全附加参数应保留');
});

test('超时：子进程不退出会被 SIGTERM→SIGKILL 收敛成 timedOut', async () => {
  const cli = fakeCli('slow.sh', 'sleep 5');
  const r = await runCli({ executable: cli, args: [], cwd: ROOT_DIR, envNames: [], timeoutMs: 600 });
  assert.equal(r.timedOut, true, '应标记超时');
});

test('非零退出码原样返回（不抛）', async () => {
  const cli = fakeCli('boom.sh', 'echo oops >&2; exit 3');
  const r = await runCli({ executable: cli, args: [], cwd: ROOT_DIR, envNames: [], timeoutMs: 5000 });
  assert.equal(r.exitCode, 3);
  assert.match(r.stderr, /oops/);
});
