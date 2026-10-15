/** Validate downloaded ZIPs with Python's independent standard-library reader. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import type {AddressInfo} from 'node:net';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'princeq-skill-download-'));
process.env.PWQ_DB_PATH = path.join(tempRoot, 'test.db');
process.env.PWQ_HABITS_DIR = path.join(tempRoot, 'habits');
process.env.PWQ_AGENT_RUNTIME_CONFIG = path.join(tempRoot, 'runtime.json');
const {buildPrinceQSkillArchive} = await import('../server/skills/archive.ts');
const {PRINCEQ_SKILL_DIRECTORY} = await import('../server/skills/injection.ts');
const {createServer} = await import('../server/index.ts');
const {applySchema, getDb, closeDb} = await import('../server/db/connection.ts');
const {seedActors} = await import('../server/db/seed.ts');
const {ensureHabitFiles} = await import('../server/domain/habits.ts');
const server = createServer();
let base: string;

function inspectZip(archive: Buffer): Record<string, string> {
  const script = [
    'import base64, io, json, sys, zipfile',
    'with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:',
    '    assert z.testzip() is None',
    '    json.dump({n:base64.b64encode(z.read(n)).decode("ascii") for n in z.namelist()}, sys.stdout)',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', script], {input: archive}).toString());
}

test.before(async () => {
  ensureHabitFiles();
  applySchema(getDb());
  seedActors(getDb());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tempRoot, {recursive: true, force: true});
});

test('HTTP download returns a valid portable ZIP and leaves JSON routes usable', async () => {
  const response = await fetch(`${base}/api/skills/princeq/download`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="PrinceQ-Agent-Skill.zip"');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(Number(response.headers.get('content-length')), bytes.length);
  const files = inspectZip(bytes);
  for (const file of ['SKILL.md', 'INSTALL.md', 'references/api-reference.md', 'references/operations.md',
    'references/scoring.md', 'scripts/pwq_client.py', 'scripts/install_skill.py']) {
    assert.equal(files[`personal-work-queue/${file}`], fs.readFileSync(path.join(PRINCEQ_SKILL_DIRECTORY, file)).toString('base64'));
  }
  assert.equal(Object.keys(files).length, 7);
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.ok(await health.json());
});

test('each build rereads source and preserves UTF-8 paths while excluding development files', async () => {
  const source = fs.mkdtempSync(path.join(tempRoot, 'source-'));
  fs.mkdirSync(path.join(source, 'references'));
  fs.mkdirSync(path.join(source, 'scripts', '__pycache__'), {recursive: true});
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: personal-work-queue\ndescription: 示例\n---\n');
  fs.writeFileSync(path.join(source, 'references', '评分.md'), '第一版评分指导');
  fs.writeFileSync(path.join(source, 'scripts', 'test_local.py'), 'local test only');
  fs.writeFileSync(path.join(source, 'scripts', '__pycache__', 'client.pyc'), 'cache only');
  fs.writeFileSync(path.join(source, '.DS_Store'), 'hidden only');
  const first = await buildPrinceQSkillArchive(source);
  assert.deepEqual(await buildPrinceQSkillArchive(source), first);
  const firstFiles = inspectZip(first);
  assert.deepEqual(Object.keys(firstFiles).sort(), ['personal-work-queue/SKILL.md', 'personal-work-queue/references/评分.md']);
  fs.writeFileSync(path.join(source, 'references', '评分.md'), '第二版评分指导');
  const secondFiles = inspectZip(await buildPrinceQSkillArchive(source));
  assert.equal(Buffer.from(secondFiles['personal-work-queue/references/评分.md'], 'base64').toString(), '第二版评分指导');
  assert.notDeepEqual(secondFiles, firstFiles);
});

test('a checkout missing SKILL.md fails instead of offering a broken download', async () => {
  const source = fs.mkdtempSync(path.join(tempRoot, 'missing-'));
  await assert.rejects(buildPrinceQSkillArchive(source), {code: 'ENOENT'});
});

test('symbolic links cannot include files outside the Skill directory', async () => {
  const source = fs.mkdtempSync(path.join(tempRoot, 'linked-'));
  fs.writeFileSync(path.join(source, 'SKILL.md'), 'skill');
  fs.symlinkSync(path.join(tempRoot, 'runtime.json'), path.join(source, 'external.json'));
  await assert.rejects(buildPrinceQSkillArchive(source), /symbolic link/);
});
