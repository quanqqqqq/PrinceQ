import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildCliEnv, runCli} from '../server/agent/cli-exec.ts';
import {resolveCliLaunch, executableFile} from '../server/lib/process-launch.ts';
import {absoluteFilesystemPath, hasParentPathSegment} from '../shared/filesystem-path.ts';
import {nodeCli} from './fixtures/cli.ts';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'PrinceQ 中文 空格-'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('Windows base environment preserves profile/runtime locations without leaking credentials or mixed-case injection',()=>{
  const source={Path:'C:\\Node;C:\\Users\\叶\\AppData\\Roaming\\npm',USERPROFILE:'C:\\Users\\叶',AppData:'C:\\Users\\叶\\AppData\\Roaming',
    LocalAppData:'C:\\Users\\叶\\AppData\\Local',SystemRoot:'C:\\Windows',TEMP:'C:\\Temp',ComSpec:'C:\\Windows\\System32\\cmd.exe',
    node_options:'--require evil',OPENAI_API_KEY:'secret',CUSTOM:'allowed'};
  const env=buildCliEnv(['Path','node_options','CUSTOM'],'codex',source,'win32');
  assert.equal(env.PATH,source.Path);assert.equal(env.HOME,source.USERPROFILE);assert.equal(env.APPDATA,source.AppData);
  assert.equal(env.LOCALAPPDATA,source.LocalAppData);assert.equal(env.SYSTEMROOT,source.SystemRoot);assert.equal(env.COMSPEC,source.ComSpec);
  assert.equal(env.TEMP,source.TEMP);assert.equal(env.CUSTOM,'allowed');assert.equal(env.OPENAI_API_KEY,undefined);
  assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.node_options,undefined);assert.equal(env.Path,undefined);
});

test('known npm Windows shim resolves to its package JS entry without executing shell text',async()=>{
  const prefix=path.join(root,'npm prefix');const directory=path.join(prefix,'node_modules','@openai','codex');
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'@openai/codex',bin:{codex:'cli.cjs'}}));
  const entry=path.join(directory,'cli.cjs');fs.writeFileSync(entry,'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const shim=path.join(prefix,'codex.cmd');fs.writeFileSync(shim,'exit /b 97');
  const args=['中文 空格','"quote"','%PATH%','& echo PWN','$(touch pwn)','C:\\Users\\叶\\项目'];
  const launch=resolveCliLaunch(shim,args,'win32');
  assert.equal(launch.executable,process.execPath);assert.deepEqual(launch.args,[fs.realpathSync(entry),...args]);
  assert.equal(executableFile(shim,'win32'),true);
  const result=await runCli({...launch,cwd:root,envNames:[],timeoutMs:5000});
  assert.equal(result.exitCode,0);assert.deepEqual(JSON.parse(result.stdout),args);
});

test('unknown or escaping Windows shell launchers fail closed',()=>{
  assert.throws(()=>resolveCliLaunch(path.join(root,'unknown.cmd'),[],'win32'),/无法安全启动/);
  const directory=path.join(root,'escape','node_modules','@openai','codex');fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'@openai/codex',bin:'../../../../outside.cjs'}));
  fs.writeFileSync(path.join(root,'outside.cjs'),'process.exit(0)');
  assert.throws(()=>resolveCliLaunch(path.join(root,'escape','codex.cmd'),[],'win32'),/无法安全启动/);
});

test('drive, UNC, spaces and dots are valid; parent traversal is detected by segments',()=>{
  for(const value of ['C:\\Users\\叶\\My Project','D:/项目/a..b','\\\\server\\share\\PrinceQ','/tmp/PrinceQ'])assert.equal(absoluteFilesystemPath(value),true,value);
  for(const value of ['C:relative','project/file','\\relative'])assert.equal(absoluteFilesystemPath(value),false,value);
  assert.equal(hasParentPathSegment('C:\\project\\..\\escape'),true);
  assert.equal(hasParentPathSegment('C:\\project\\release..candidate'),false);
});

test('stdin Unicode survives pipes and chunk boundaries in paths with spaces',async()=>{
  const file=nodeCli(path.join(root,'echo 输入'),"process.stdin.pipe(process.stdout);");
  const text='中文🙂'.repeat(10000);
  const result=await runCli({executable:file,args:[],cwd:root,envNames:[],input:text,maxOutputBytes:200000,timeoutMs:5000});
  assert.equal(result.exitCode,0);assert.equal(result.stdout,text);
});

test('cancellation terminates an active child and pre-aborted calls never spawn',async()=>{
  const marker=path.join(root,'started');const file=nodeCli(path.join(root,'cancel'),`require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes');setInterval(()=>{},1000);`);
  const already=new AbortController();already.abort();
  const stopped=await runCli({executable:file,args:[],cwd:root,envNames:[],timeoutMs:5000,signal:already.signal});
  assert.equal(stopped.canceled,true);assert.equal(fs.existsSync(marker),false);
  const controller=new AbortController();let started:()=>void;const output=new Promise<void>(resolve=>{started=resolve;});
  const live=nodeCli(path.join(root,'live-cancel'),"console.log('ready');setInterval(()=>{},1000);");
  const work=runCli({executable:live,args:[],cwd:root,envNames:[],timeoutMs:5000,signal:controller.signal,onFirstStdout:()=>started()});
  await output;controller.abort();const result=await work;assert.equal(result.canceled,true);assert.equal(result.timedOut,false);
});

test('atomic replacement retries transient Windows locks and preserves old data after persistent failure',async t=>{
  const {writeFileAtomically}=await import('../server/lib/atomic-file.ts');
  const file=path.join(root,'settings.json');writeFileAtomically(file,'old');
  const rename=fs.renameSync;let attempts=0;
  const transient=t.mock.method(fs,'renameSync',((from:fs.PathLike,to:fs.PathLike)=>{
    if(++attempts<3)throw Object.assign(new Error('scanner lock'),{code:'EPERM'});
    return rename(from,to);
  }) as typeof fs.renameSync);
  writeFileAtomically(file,'new','win32');assert.equal(fs.readFileSync(file,'utf8'),'new');assert.equal(attempts,3);
  transient.mock.restore();
  t.mock.method(fs,'renameSync',()=>{throw Object.assign(new Error('persistent lock'),{code:'EBUSY'});});
  assert.throws(()=>writeFileAtomically(file,'lost','win32'),/persistent lock/);
  assert.equal(fs.readFileSync(file,'utf8'),'new');
  assert.equal(fs.readdirSync(root).some(name=>name.startsWith('settings.json.')&&name.endsWith('.tmp')),false);
});

test('project-local Windows npm .bin layout resolves without running the shim',()=>{
  const directory=path.join(root,'local','node_modules','@anthropic-ai','claude-code');
  fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'@anthropic-ai/claude-code',bin:{claude:'cli.cjs'}}));
  fs.writeFileSync(path.join(directory,'cli.cjs'),'console.log("ok")');
  const bin=path.join(root,'local','node_modules','.bin');fs.mkdirSync(bin);const shim=path.join(bin,'claude.cmd');fs.writeFileSync(shim,'exit /b 97');
  assert.equal(resolveCliLaunch(shim,[],'win32').args[0],fs.realpathSync(path.join(directory,'cli.cjs')));
});

test('model catalog RPC shares the same safe launcher',async()=>{
  const {readCodexModelRpc}=await import('../server/agent/model-catalog.ts');
  const {defaultRuntimeConfig}=await import('../server/agent/runtime-config.ts');
  const file=nodeCli(path.join(root,'rpc model'),`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const message=JSON.parse(line);if(!message.id)return;
    process.stdout.write(JSON.stringify({id:message.id,result:message.method==='model/list'?{data:[{model:'fixture-model',displayName:'Fixture'}]}:{}})+'\\n');
  });`);
  const result=await readCodexModelRpc({...defaultRuntimeConfig(),cli_path:file,working_directory:root});
  assert.equal(result[0].id,'fixture-model');
});

test('SQLite migration and persistence work in a Unicode path across close and reopen',async()=>{
  const {openDatabase,applySchema}=await import('../server/db/connection.ts');
  const filename=path.join(root,'本地 数据','工作队列.db');
  let db=openDatabase(filename);applySchema(db);
  db.exec("CREATE TABLE portability_probe (value TEXT NOT NULL)");
  db.prepare('INSERT INTO portability_probe VALUES (?)').run('中文🙂');db.close();
  db=openDatabase(filename);applySchema(db);
  try {assert.equal(db.prepare('SELECT value FROM portability_probe').get()?.value,'中文🙂');}
  finally {db.close();}
  fs.renameSync(filename,filename+'.moved');fs.rmSync(filename+'.moved');
});
