/**
 * 守住"习惯文件写入不再触发 Vite 整页刷新"这条回归。
 *
 * Vite 开发服务器默认监听项目根；habits/*.json 由独立 Node API 进程原子重命名
 * 写入，data/*.db-wal 由 SQLite 自己刷盘。这些都不是前端 import 链上的文件，
 * Vite 一旦监听到就会退化成整页刷新，把助手面板里没发出去的草稿和会话一起冲掉。
 *
 * 这条测试静态断言 vite.config.ts 里显式忽略了这些目录，防止后续重构把它删掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(here, '..', 'vite.config.ts');

test('vite.config.ts 显式忽略 habits/ 与 data/，避免习惯写入触发整页刷新', () => {
  const src = fs.readFileSync(configPath, 'utf8');
  // 定位 server.watch.ignored 块
  assert.match(src, /watch:\s*\{/, 'vite.config.ts 应有 server.watch 配置');
  assert.match(src, /ignored:\s*\[/, '应有 watch.ignored 数组');
  for (const pattern of ['**/habits/**', '**/data/**', '**/dist/**']) {
    assert.match(
      src,
      new RegExp(pattern.replace(/\//g, '\\/').replace(/\*\*/g, '\\*\\*')),
      `watch.ignored 应包含 ${pattern}`,
    );
  }
});
