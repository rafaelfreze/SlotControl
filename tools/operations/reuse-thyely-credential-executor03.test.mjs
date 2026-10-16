import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { SCOPE, envelopeAad, encryptEnvelope, decryptEnvelope, sourceProgram, targetProgram } from './reuse-thyely-credential-executor03.mjs';
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
