#!/usr/bin/env node
/** Explicitly authorized one-account operation; not a credential export API.
 * SSH host keys are mandatory. Secrets are encrypted on 01 to an ephemeral
 * public key generated in RAM on 03, and re-sealed by the official vault on 03.
 * This workstation handles ciphertext only. No orders, registry, DB, source
 * credential, private key, HMAC or other account are changed.
 */
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, constants, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const SCOPE = Object.freeze({ operator_id: 'd508bb3e-5a1d-4579-bd7a-de171c118d25',
  exchange_account_id: '5580c011-6ff1-44bd-b568-85932b424ceb',
  credential_ref: 'account_5580c0116ff144bdb56885932b424ceb', environment: 'REAL' });
const SOURCE = '46.101.104.48', TARGET = '167.71.37.166';

export function envelopeAad(challenge) {
  if (challenge?.version !== 1 || challenge.source !== 'executor-01' || challenge.target !== 'executor-03'
    || challenge.source_ip !== '46.101.104.48' || challenge.target_ip !== '167.71.37.166'
    || challenge.scope?.operator_id !== 'd508bb3e-5a1d-4579-bd7a-de171c118d25'
    || challenge.scope?.exchange_account_id !== '5580c011-6ff1-44bd-b568-85932b424ceb'
    || challenge.scope?.credential_ref !== 'account_5580c0116ff144bdb56885932b424ceb'
    || challenge.scope?.environment !== 'REAL' || !/^[a-f0-9]{64}$/.test(challenge.nonce ?? '')
    || !Number.isSafeInteger(challenge.created_at) || Date.now() - challenge.created_at > 90000
    || challenge.created_at > Date.now() + 5000) throw new Error('REUSE_CHALLENGE_DENIED');
  return Buffer.from(JSON.stringify(challenge));
}

export function encryptEnvelope(challenge, publicKey, payload) {
  const key = randomBytes(32), iv = randomBytes(12), aad = envelopeAad(challenge);
  const plaintext = Buffer.from(JSON.stringify(payload));
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { version: 1, wrapped_key: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256' }, key).toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') };
  } finally { key.fill(0); plaintext.fill(0); }
}

export function decryptEnvelope(challenge, privateKey, envelope) {
  const aad = envelopeAad(challenge);
  if (envelope?.version !== 1 || JSON.stringify(envelope).length > 16384) throw new Error('REUSE_ENVELOPE_DENIED');
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256' }, Buffer.from(envelope.wrapped_key, 'base64'));
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8'));
    if (!/^[a-f0-9]{64}$/.test(payload.uid_hash ?? '') || !/^[a-f0-9]{64}$/.test(payload.credential_hash ?? '')
      || !/^[A-Za-z0-9]{32,128}$/.test(payload.apiKey ?? '') || !/^[A-Za-z0-9]{32,128}$/.test(payload.apiSecret ?? ''))
      throw new Error('REUSE_PAYLOAD_DENIED');
    return payload;
  } finally { key.fill(0); plaintext?.fill(0); }
}

function remotePrelude(shard, ip, codeRoot) {
  return `import {loadEnvFile} from 'node:process';
import {join} from 'node:path';
import {createCipheriv,createDecipheriv,createHash,constants,privateDecrypt,publicEncrypt,randomBytes,generateKeyPairSync} from 'node:crypto';
import {credentialMetadata,loadCredential,inspectBinanceCredential,saveCredential} from ${JSON.stringify(`${codeRoot}/src/credential-vault.mjs`)};
loadEnvFile('/etc/coinops/live-executor.env');
if ((process.env.COINOPS_EXECUTOR_SHARD_ID || 'executor-01') !== ${JSON.stringify(shard)} || process.env.LIVE_EXECUTOR_EGRESS_IP !== ${JSON.stringify(ip)}) throw new Error('REUSE_HOST_DENIED');
process.setgroups([]); process.setgid('coinops-executor'); process.setuid('coinops-executor');
const scope=${JSON.stringify(SCOPE)};
const directory=join(process.env.COINOPS_EXECUTOR_STATE_DIR,'credentials');
const masterSecret=process.env.COINOPS_EXECUTOR_HMAC_SECRET;
const readInput=async()=>{let value='';for await(const chunk of process.stdin){value+=chunk;if(value.length>32768)throw new Error('REUSE_INPUT_DENIED');}return JSON.parse(value);};
${envelopeAad.toString()}
${encryptEnvelope.toString()}
${decryptEnvelope.toString()}
`;
}

export function sourceProgram() {
  return remotePrelude('executor-01', SOURCE, '/opt/coinops/source/apps/live-executor') + `
try {
 const {challenge,public_key}=await readInput(); envelopeAad(challenge);
 const before=await credentialMetadata(directory,scope);
 if(!before?.uidHash||!before?.fingerprint)throw new Error('REUSE_SOURCE_IDENTITY_UNPROVEN');
 const secret=await loadCredential(directory,masterSecret,scope);
 try {
  const observation=await inspectBinanceCredential({...secret,environment:'REAL',expectedEgressIp:${JSON.stringify(SOURCE)}});
  const after=await credentialMetadata(directory,scope);
  // Older vault documents have no credential_hash. Fresh authenticated GETs
  // prove it; the stored UID and key fingerprint must still match exactly.
  if(observation.status!=='PASS'||observation.uidHash!==before.uidHash
   ||createHash('sha256').update(secret.apiKey).digest('hex').slice(0,12)!==before.fingerprint
   ||before.credentialHash&&observation.credentialHash!==before.credentialHash
   ||after?.fingerprint!==before.fingerprint||after?.uidHash!==before.uidHash
   ||after?.credentialHash!==before.credentialHash)throw new Error('REUSE_SOURCE_VALIDATION_FAILED');
  const envelope=encryptEnvelope(challenge,public_key,{...secret,uid_hash:observation.uidHash,credential_hash:observation.credentialHash});
  process.stdout.write(JSON.stringify(envelope)+'\\n');
 } finally {secret.apiKey='';secret.apiSecret='';}
} catch {process.stderr.write('REUSE_SOURCE_FAILED\\n');process.exitCode=1;}
`;
}

export function targetProgram() {
  return remotePrelude('executor-03', TARGET, '/opt/coinops/current/apps/live-executor') + `
try {
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:3072});
 const challenge={version:1,source:'executor-01',target:'executor-03',source_ip:${JSON.stringify(SOURCE)},target_ip:${JSON.stringify(TARGET)},scope,nonce:randomBytes(32).toString('hex'),created_at:Date.now()};
 process.stdout.write(JSON.stringify({type:'READY',challenge,public_key:publicKey.export({type:'spki',format:'pem'})})+'\\n');
 const payload=decryptEnvelope(challenge,privateKey,await readInput());
 try {
  const previous=await credentialMetadata(directory,scope);
  if(previous&&(previous.uidHash!==payload.uid_hash||previous.credentialHash!==payload.credential_hash))throw new Error('REUSE_TARGET_ALREADY_DIFFERENT');
  const observation=await inspectBinanceCredential({apiKey:payload.apiKey,apiSecret:payload.apiSecret,environment:'REAL',expectedEgressIp:${JSON.stringify(TARGET)}});
  if(observation.status!=='PASS'||observation.whitelistAccepted!==true||observation.executorIp!==${JSON.stringify(TARGET)}
   ||observation.uidHash!==payload.uid_hash||observation.credentialHash!==payload.credential_hash)throw new Error('REUSE_TARGET_VALIDATION_FAILED');
  await saveCredential({directory,masterSecret,scope,apiKey:payload.apiKey,apiSecret:payload.apiSecret,observation,replace:false});
  const installed=await credentialMetadata(directory,scope);
  if(installed?.uidHash!==payload.uid_hash||installed?.credentialHash!==payload.credential_hash)throw new Error('REUSE_TARGET_READBACK_FAILED');
  const readback=await loadCredential(directory,masterSecret,scope);
  try {if(readback.apiKey!==payload.apiKey||readback.apiSecret!==payload.apiSecret)throw new Error('REUSE_TARGET_PAYLOAD_READBACK_FAILED');}
  finally {readback.apiKey='';readback.apiSecret='';}
  process.stdout.write(JSON.stringify({type:'RESULT',status:'PASS',account:'Thyely',environment:'REAL',source:'executor-01',target:'executor-03',executor_ip:${JSON.stringify(TARGET)},uid_match:true,credential_match:true,whitelist_accepted:true,credential_installed:true,source_unchanged:true,already_present:!!previous,validated_at:observation.validatedAt,orders_submitted:0})+'\\n');
 } finally {payload.apiKey='';payload.apiSecret='';}
} catch {process.stderr.write('REUSE_TARGET_FAILED\\n');process.exitCode=1;}
`;
}

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
function ssh(ip, program) {
  const child = spawn('ssh.exe', ['-T','-i','C:\\Users\\rafae\\.ssh\\coinops_executor_notebook_ed25519',
    '-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',`root@${ip}`,
    '/usr/local/bin/node','--input-type=module','-e',shellQuote(program)], { stdio: ['pipe','pipe','pipe'], windowsHide:true });
  child.stdin.on('error',()=>child.kill());
  let output='',errorBytes=0;
  child.stderr.on('data', chunk => { errorBytes+=chunk.length; if(errorBytes>8192)child.kill(); });
  child.stdout.on('data', chunk => { output+=chunk; if(output.length>65536)child.kill(); });
  const completed = new Promise((accept,reject) => {
    child.once('error',()=>reject(new Error('REUSE_SSH_UNAVAILABLE')));
    child.once('close',code=>code===0?accept(output):reject(new Error('REUSE_REMOTE_FAILED_NO_SECRETS_LOGGED')));
  });
  // Observe immediately: a target failure while waiting for READY must not
  // become an unhandled rejection. The caller still checks the same promise.
  completed.catch(()=>{});
  return {child,completed,get output(){return output;}};
}

export async function reuseAuthorizedCredential() {
  const target=ssh(TARGET,targetProgram());
  let source;
  const deadline=Date.now()+110000;
  const timer=setTimeout(()=>{source?.child.kill();target.child.kill();},110000);
  try {
    while(!target.output.includes('\n')) {
      if(target.child.exitCode!==null||Date.now()>deadline)throw new Error('REUSE_TARGET_NOT_READY');
      await new Promise(accept=>setTimeout(accept,50));
    }
    const ready=JSON.parse(target.output.split('\n')[0]);
    if(ready.type!=='READY')throw new Error('REUSE_TARGET_NOT_READY');
    envelopeAad(ready.challenge);
    source=ssh(SOURCE,sourceProgram());
    source.child.stdin.end(JSON.stringify({challenge:ready.challenge,public_key:ready.public_key}));
    const ciphertext=JSON.parse((await source.completed).trim());
    if(ciphertext.version!==1||!ciphertext.ciphertext)throw new Error('REUSE_SOURCE_PROTOCOL_FAILED');
    target.child.stdin.end(JSON.stringify(ciphertext));
    const result=(await target.completed).trim().split('\n').map(line=>JSON.parse(line)).find(row=>row.type==='RESULT');
    if(result?.status!=='PASS')throw new Error('REUSE_TARGET_RESULT_UNPROVEN');
    return result;
  } finally {clearTimeout(timer);source?.child.kill();target.child.kill();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==3||process.argv[2]!=='--apply-thyely-01-to-03'){
    process.stderr.write('Explicit --apply-thyely-01-to-03 is required. No action taken.\n');process.exitCode=2;
  } else {try{console.log(JSON.stringify(await reuseAuthorizedCredential()));}catch{console.error('REUSE_NOT_CONFIRMED: inspect sanitized metadata; do not retry blindly.');process.exitCode=1;}}
}
