import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'princeq-model-catalog-'));
process.env.PWQ_HABITS_DIR=path.join(temp,'habits');process.env.PWQ_AGENT_RUNTIME_CONFIG=path.join(temp,'config.json');process.env.CODEX_HOME=path.join(temp,'codex');
const {parseClaudeModelHelp,normalizeCodexModels,discoverRuntimeModels}=await import('../server/agent/model-catalog.ts');
const {defaultRuntimeConfig}=await import('../server/agent/runtime-config.ts');
test.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
test('Claude choices come from the installed help block, not unrelated quoted examples',()=>{
  const models=parseClaudeModelHelp("  --model <model> alias (e.g. 'fable', 'opus', or 'sonnet') or full name 'claude-fable-5'.\n  --other <x> 'haiku'\n");
  assert.deepEqual(models.map(model=>model.id),['fable','opus','sonnet']);assert.ok(models.every(model=>model.source==='cli_help'));
});
test('Codex uses returned identifiers, filters hidden entries and removes duplicates',()=>{
  const models=normalizeCodexModels([{model:'custom-v2',displayName:'Custom Model',isDefault:true},{slug:'hidden-v1',visibility:'hide'},{model:'secret',hidden:true},{model:'custom-v2'},{model:'sk-credential'}]);
  assert.equal(models.length,1);assert.equal(models[0].id,'custom-v2');assert.equal(models[0].is_default,true);
});
test('metadata discovery does not send inference or mutate runtime settings',async()=>{
  const file=path.join(temp,'claude.sh');fs.writeFileSync(file,"#!/bin/sh\nif [ \"$1\" = '--help' ]; then printf \"  --model <model> aliases 'opus', 'sonnet'\n\"; exit 0; fi\nexit 91\n",{mode:0o755});
  const cfg={...defaultRuntimeConfig(),cli_path:file};
  const catalog=await discoverRuntimeModels(cfg,'claude',true);
  assert.equal(catalog.supports_model_flag,true);assert.equal(catalog.access_verified,false);assert.deepEqual(catalog.models.map(model=>model.id),['opus','sonnet']);assert.equal(fs.existsSync(process.env.PWQ_AGENT_RUNTIME_CONFIG!),false);
});
test('unsupported CLI model flag has no fabricated choices',async()=>{
  const file=path.join(temp,'no-model.sh');fs.writeFileSync(file,'#!/bin/sh\necho "no model flag"\n',{mode:0o755});
  const catalog=await discoverRuntimeModels({...defaultRuntimeConfig(),cli_path:file},'claude',true);
  assert.equal(catalog.supports_model_flag,false);assert.deepEqual(catalog.models,[]);
});
