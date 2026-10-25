import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SCOPE, SAMYA_SCOPE, samyaDirection, envelopeAad, encryptEnvelope, decryptEnvelope, sourceProgram, targetProgram } from './reuse-thyely-credential-executor03.mjs';
const key=generateKeyPairSync('rsa',{modulusLength:3072});
const challenge=()=>({version:1,source:'executor-01',target:'executor-03',source_ip:'46.101.104.48',target_ip:'167.71.37.166',scope:{...SCOPE},nonce:randomBytes(32).toString('hex'),created_at:Date.now()});
const payload={apiKey:'K'.repeat(64),apiSecret:'S'.repeat(64),uid_hash:'a'.repeat(64),credential_hash:'b'.repeat(64)};
test('workstation receives only envelope encrypted to target ephemeral key',()=>{
 const c=challenge(),e=encryptEnvelope(c,key.publicKey,payload);
 assert.equal(JSON.stringify(e).includes(payload.apiSecret),false);
 assert.deepEqual(decryptEnvelope(c,key.privateKey,e),payload);
});
test('challenge, ciphertext and recipient tampering fail closed',()=>{
 const c=challenge(),e=encryptEnvelope(c,key.publicKey,payload);
 assert.throws(()=>decryptEnvelope({...c,nonce:randomBytes(32).toString('hex')},key.privateKey,e));
 assert.throws(()=>decryptEnvelope(c,key.privateKey,{...e,tag:Buffer.alloc(16).toString('base64')}));
 const other=generateKeyPairSync('rsa',{modulusLength:3072});
 assert.throws(()=>decryptEnvelope(c,other.privateKey,e));
});
test('only authorized account, direction, IP and fresh short-lived challenge',()=>{
 const c=challenge();
 for(const changed of [{...c,target:'executor-02'},{...c,target_ip:'67.71.37.166'},
  {...c,scope:{...SCOPE,exchange_account_id:'00000000-0000-4000-8000-000000000001'}},
  {...c,created_at:Date.now()-90001},{...c,created_at:Date.now()+6000}])assert.throws(()=>envelopeAad(changed));
});
test('remote programs use official vault, no plaintext source output or order transport',()=>{
 assert.match(sourceProgram(),/process\.stdout\.write\(JSON\.stringify\(envelope\)/);
 assert.match(sourceProgram(),/before.credentialHash&&observation.credentialHash!==before.credentialHash/);
 assert.match(sourceProgram(),/createHash\('sha256'\).update\(secret.apiKey\)/);
 assert.match(targetProgram(),/saveCredential\(/);
 assert.match(targetProgram(),/replace:false/);
 assert.match(targetProgram(),/observation.uidHash!==payload.uid_hash/);
 assert.match(targetProgram(),/process.setuid\('coinops-executor'\)/);
 assert.match(targetProgram(),/process.setgroups\(\[\]\)/);
 assert.match(targetProgram(),/readback.apiSecret!==payload.apiSecret/);
 assert.doesNotMatch(sourceProgram()+targetProgram(),/\/api\/v3\/order|writeFile|apiKey:process\.env/);
});

test('Samya is authorized only from 03 to 02, with unchanged physical owner',()=>{
 for(const shard of ['executor-02']) {
  const d=samyaDirection(shard),c={...challenge(),scope:{...SAMYA_SCOPE},source:d.source,
   target:d.target,source_ip:d.sourceIp,target_ip:d.targetIp};
  assert.deepEqual(decryptEnvelope(c,key.privateKey,encryptEnvelope(c,key.publicKey,payload)),payload);
  for(const patch of [{target_ip:'67.71.37.166'},{source:'executor-01'},
   {scope:{...SAMYA_SCOPE,credential_ref:SCOPE.credential_ref}},
   {scope:{...SAMYA_SCOPE,operator_id:'00000000-0000-4000-8000-000000000001'}}])
   assert.throws(()=>envelopeAad({...c,...patch}));
  const p=sourceProgram(d)+targetProgram(d);
  assert.match(p,/replace:false/); assert.match(p,/observation.uidHash!==payload.uid_hash/);
  assert.doesNotMatch(p,/\/api\/v3\/order|writeFile/);
 }
 assert.throws(()=>samyaDirection('executor-03'));
 assert.throws(()=>samyaDirection('executor-01'));
});

test('remote programs parse and never install before authenticated destination proof',()=>{
 for(const direction of [undefined,samyaDirection('executor-02')]) {
  for(const program of [sourceProgram(direction),targetProgram(direction)]) {
   const parsed=spawnSync(process.execPath,['--check','--input-type=module'],{input:program,encoding:'utf8'});
   assert.equal(parsed.status,0,parsed.stderr);
  }
  const program=targetProgram(direction);
  assert.ok(program.indexOf("observation.uidHash!==payload.uid_hash")<program.indexOf('await saveCredential('));
  assert.match(program,/data\.code/); assert.doesNotMatch(program,/data\.message/);
 }
});
