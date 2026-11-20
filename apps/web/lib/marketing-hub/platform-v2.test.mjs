import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
const ts=createRequire(import.meta.url)('typescript');
function adapter(){
 const rpcCalls=[],writes=[],exports=[];
 const source={rpc:(name,args)=>{rpcCalls.push({name,args});return Promise.resolve({data:true,error:null});}};
 const mocks={
 'server-only':{},
 '@/vendor/marketing-1.3.2/kit.mjs':{addDays:(date,n)=>new Date(new Date(date+'T12:00:00Z').getTime()+n*86400000).toISOString().slice(0,10),emptyDashboard:period=>({period,quality:'complete'})},
 '@/vendor/marketing-1.4.18/model.js':{fromSnapshots:base=>base},
 '@/vendor/marketing-1.4.18/epoch-server.js':{recordEpochActivity:async(db,tenant,input)=>{writes.push({db,tenant,input});return true;},serveEpochExport:async(request,product,db)=>{exports.push({product,db});return new Response(null,{status:204});},readLocalEpochSnapshot:async()=>{throw Error('unavailable');},mergeEpochEngagement:()=>({})},
 './website-source':{websiteDb:()=>source,websiteProduct:'coinops'}
 };
 const module={exports:{}};const code=ts.transpileModule(readFileSync('lib/marketing-hub/epoch.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,Response,process:{env:{}},require:key=>{if(!(key in mocks))throw Error('unexpected dependency '+key);return mocks[key];}});
 return {...module.exports,rpcCalls,writes,exports};
}
test('institutional counter rejects tenant scopes before writing',async()=>{const a=adapter();assert.equal(await a.recordPlatformActivity('00000000-0000-4000-8000-000000000001',{version:2}),false);assert.equal(a.writes.length,0);});
test('refused consent preserves operational action without attribution or campaign',async()=>{const a=adapter();await a.recordPlatformActivity('platform',{version:2,consent:'declined',channel:'google_ads',campaign:'private-campaign',attributionV1:{secret:'fixture'},organicSocialNetworkV2:'instagram',event:'contact_intent'});const {tenant,input}=a.writes[0];assert.equal(tenant,'platform');assert.equal(input.channel,'other');assert.equal(input.campaign,'');assert.equal(input.event,'contact_intent');assert.equal('attributionV1' in input,false);assert.equal('organicSocialNetworkV2' in input,false);});
test('accepted channel remains eligible and nonce resolves only the own website RPC',async()=>{const a=adapter();await a.recordPlatformActivity('platform',{version:2,consent:'accepted',channel:'meta'});assert.equal(a.writes[0].input.channel,'meta');await a.platformEpochDb().rpc('consume_marketing_hub_nonce',{p_nonce:'fixture'});assert.equal(a.rpcCalls[0].name,'claim_website_read_nonce_v1');});
test('HMAC export fixes the product adapter and never switches to tenant/business backend',async()=>{const a=adapter();assert.equal((await a.postPlatformEpochExport(new Request('https://example.invalid/api/marketing-hub/export-v2'))).status,204);assert.equal(a.exports[0].product,'coinops');});
test('unavailable v2 source stays disconnected without legacy fallback or synthetic zeros',async()=>{const a=adapter();const result=await a.readPlatformEpochDashboard({from:'2026-11-01',to:'2026-11-20'});assert.equal(result.quality,'disconnected');assert.equal('metrics' in result,false);assert.match(result.notice,/Histórico anterior preservado/);});
