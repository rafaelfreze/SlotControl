#!/usr/bin/env node
// Explicit single-operation authorization, never a generic exchange transport.
// Secret via stdin only; no retry of an uncertain control-plane response.
import{createInterface}from'node:readline';
import{resolve}from'node:path';
import{fileURLToPath}from'node:url';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function requestMissedMarketEntry(args,secret,fetcher=fetch){
 const[account,engine,asset,run,slot,operation]=args;
 if(args.length!==6||![account,engine,run].every(v=>UUID.test(v??''))||!['BTC','SOL'].includes(asset)
  ||!/^\d+$/.test(slot??'')||!/^\d+$/.test(operation??'')||Number(slot)<1||Number(slot)>100
  ||!Number.isSafeInteger(Number(operation))||Number(operation)<1
  ||typeof secret!=='string'||secret.length<32||/[\r\n]/.test(secret))throw Error('COINOPS_CONTROL_INPUT_INVALID');
 const response=await fetcher('https://cripto-flax.vercel.app/api/cron/live-control',{method:'POST',redirect:'error',
  headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},
  body:JSON.stringify({action:'REENTER_MISSED_MARKET',asset,exchange_account_id:account,trading_engine_id:engine,
   run_id:run,slot_number:Number(slot),operation_sequence:Number(operation)}),signal:AbortSignal.timeout(60000)});
 const value=await response.json().catch(()=>null);
 if(!response.ok||!['MARKET_ENTRY_AUTHORIZED','MARKET_ENTRY_ALREADY_PREPARED'].includes(value?.status)
  ||value.cycle_id!==run||value.slot_number!==Number(slot)||value.operation_sequence!==Number(operation))
  throw Error(/^COINOPS_[A-Z0-9_]+$/.test(value?.error??'')?value.error:'COINOPS_CONTROL_RESPONSE_UNCONFIRMED');
 return{status:value.status,engine_id:engine,cycle_id:run,slot_number:Number(slot),operation_sequence:Number(operation)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.stdin.isTTY)process.stdin.setRawMode(true);
 const lines=createInterface({input:process.stdin,terminal:false});
 try{const secret=await new Promise((done,reject)=>{lines.once('line',done);lines.once('close',()=>reject(Error('COINOPS_CONTROL_SECRET_MISSING')));});
  lines.close();if(process.stdin.isTTY)process.stdin.setRawMode(false);
  console.log(JSON.stringify(await requestMissedMarketEntry(process.argv.slice(2),secret)));
 }catch(e){console.error(JSON.stringify({status:'UNCONFIRMED',code:/^COINOPS_[A-Z0-9_]+$/.test(e?.message??'')?e.message:'COINOPS_CONTROL_RESPONSE_UNKNOWN'}));process.exitCode=1;}
}
