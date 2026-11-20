import 'server-only';
import {addDays,emptyDashboard,type HubPeriod} from '@/vendor/marketing-1.3.2/kit.mjs';
import {fromSnapshots} from '@/vendor/marketing-1.4.18/model.js';
import {readLocalEpochSnapshot,mergeEpochEngagement,recordEpochActivity,serveEpochExport,type EpochRpc,type EpochSnapshot} from '@/vendor/marketing-1.4.18/epoch-server.js';
import type {OperationalV2Input} from '@/vendor/marketing-1.4.18/operational-server.js';
import {websiteDb,websiteProduct} from './website-source';
export function platformEpochDb():EpochRpc{
 const source=websiteDb(),epoch=source as unknown as EpochRpc;
 return {rpc:(name,args)=>name==='consume_marketing_hub_nonce'?source.rpc('claim_website_read_nonce_v1',args):epoch.rpc(name,args)};
}
export function recordPlatformActivity(externalTenant:string,input:OperationalV2Input){
 if(externalTenant!=='platform')return Promise.resolve(false);
 const {attributionV1:_attribution,organicSocialNetworkV2:_network,...event}=input;void _attribution;void _network;
 return recordEpochActivity(platformEpochDb(),'platform',{...event,channel:input.consent==='accepted'?input.channel:'other',campaign:''});
}
export async function postPlatformEpochExport(request:Request){return serveEpochExport(request,websiteProduct,platformEpochDb(),process.env.MARKETING_CENTRAL_READ_SECRET??'');}
export async function readPlatformEpochDashboard(period:HubPeriod){
 const base=emptyDashboard(period,"CoinOps · site institucional",'all');
 try{const parts:EpochSnapshot[]=[];for(let from=period.from;from<=period.to;from=addDays(from,31))parts.push(await readLocalEpochSnapshot({product:websiteProduct,externalTenant:'platform',from,to:addDays(from,30)<period.to?addDays(from,30):period.to},platformEpochDb()));return {...fromSnapshots(base,parts),...mergeEpochEngagement(parts)};}
 catch{return {...base,quality:'disconnected' as const,notice:'A medição institucional v2 aguarda ativação ou confirmação da fonte. Histórico anterior preservado separadamente.'};}
}
