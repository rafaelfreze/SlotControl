import { createHash } from "node:crypto";

/** Resource observation of the real deployed transport against an in-memory
 * exchange. No env, files, vault, live registry or real network is read. */
export async function runSlotWorkloadResourceProbe(BinanceLiveTransport,shardedEngineMap,slotCounts=[25,100]) {
  const check=(condition,message)=>{if(!condition)throw new Error(`OFFLINE_PROBE:${message}`);};
  check(typeof shardedEngineMap==="function","canonical shard scheduler required");
  check(Array.isArray(slotCounts)&&slotCounts.length>0&&slotCounts.length<=3
    &&new Set(slotCounts).size===slotCounts.length&&slotCounts.every(count=>Number.isSafeInteger(count)&&count>=2&&count<=100),"slot counts invalid");
  const results=[];
  const resourceStart=process.resourceUsage();
  const wallStart=performance.now();
  for(const count of slotCounts){
    const started=performance.now(),cpuBefore=process.cpuUsage(),rssBefore=process.memoryUsage().rss;
    const requests=[],byOrder=new Map(),engines=[];
    let active=0,peak=0,post=0,closed=0;
    const phaseByEngine=new Map(),activeByPhase=new Map(),peakByPhase=new Map(),closedByEngine=new Map();
    const enginesActiveByShard=new Map(),enginesPeakByShard=new Map();
    const weight=url=>{
      if(url.pathname==="/api/v3/time")return 1;
      if(["/api/v3/account","/api/v3/exchangeInfo"].includes(url.pathname))return 20;
      if(url.pathname==="/sapi/v1/account/apiRestrictions")return 1;
      if(url.pathname==="/api/v3/ticker/price")return 2;
      if(url.pathname==="/api/v3/openOrders")return 6;
      if(url.pathname==="/api/v3/order")return 4;
      if(url.pathname==="/api/v3/myTrades"){check(url.searchParams.has("orderId"),"unscoped trades");return 5;}
      throw new Error("OFFLINE_PROBE:unknown request");
    };
    const now=Date.now();
    for(const [index,slots]of [[1,count],[2,25],[3,25]]){
      const engine={operator_id:"00000000-0000-4000-8000-000000000001",exchange_account_id:"00000000-0000-4000-8000-000000000002",
        trading_engine_id:`10000000-0000-4000-8000-${String(index).padStart(12,"0")}`,symbol:"SOLBRL",base_asset:"SOL",quote_asset:"BRL",
        legacy_ownership:false,slot_count:slots,executor_shard_id:"executor-03"};
      const prefix=`C2-${createHash("sha256").update(`${engine.exchange_account_id}|${engine.trading_engine_id}`).digest("hex").slice(0,10)}-`;
      const orders=[];
      const quantity=slots===50?".044":".022",quoteQuantity=slots===50?"22.66":"11.33";
      for(let slot=1;slot<=slots;slot++){
        const order={symbol:"SOLBRL",clientOrderId:`${prefix}${slot}-S-${createHash("sha256").update(`${index}|${slot}`).digest("hex").slice(0,14)}`,
          orderId:index*10000+slot,side:"SELL",status:"FILLED",executedQty:quantity,cummulativeQuoteQty:quoteQuantity,price:"515",origQty:quantity};
        byOrder.set(String(order.orderId),order);orders.push(order);
      }
      engines.push({engine,orders});
    }
    const fetcher=async(input,init={},engineId)=>{
      const url=new URL(input),method=init.method??"GET";
      if(method!=="GET"){post++;throw new Error("OFFLINE_PROBE:financial method denied");}
      check(["api.binance.com","data-api.binance.vision"].includes(url.hostname),"unknown host");
      // No artificial global GET semaphore: each engine has its actual local
      // worker count, and the canonical cron scheduler limits engines/shard.
      const phase=phaseByEngine.get(engineId)??"STATE";
      active++;peak=Math.max(peak,active);
      activeByPhase.set(phase,(activeByPhase.get(phase)??0)+1);
      peakByPhase.set(phase,Math.max(peakByPhase.get(phase)??0,activeByPhase.get(phase)));
      try{
        await Promise.resolve();
        requests.push({host:url.hostname,path:url.pathname,weight:weight(url)});
        if(url.pathname==="/api/v3/time")return Response.json({serverTime:now});
        if(url.pathname==="/api/v3/account")return Response.json({canTrade:true,balances:[{asset:"BRL",free:"1100",locked:"0"},{asset:"BNB",free:".005",locked:"0"}]});
        if(url.pathname==="/sapi/v1/account/apiRestrictions")return Response.json({ipRestrict:true,enableReading:true,enableSpotAndMarginTrading:true,
          enableWithdrawals:false,enableInternalTransfer:false,permitsUniversalTransfer:false,enableMargin:false,enableFutures:false,
          enableVanillaOptions:false,enablePortfolioMarginTrading:false,enableFixApiTrade:false});
        if(url.pathname==="/api/v3/exchangeInfo")return Response.json({symbols:[{symbol:"SOLBRL",baseAsset:"SOL",quoteAsset:"BRL",filters:[
          {filterType:"LOT_SIZE",minQty:".001",maxQty:"100000",stepSize:".001"},{filterType:"PRICE_FILTER",minPrice:".1",maxPrice:"1000000",tickSize:".1"},
          {filterType:"NOTIONAL",minNotional:"10"}]}]});
        if(url.pathname==="/api/v3/ticker/price")return Response.json({symbol:url.searchParams.get("symbol"),price:"500"});
        if(url.pathname==="/api/v3/openOrders")return Response.json([]);
        const order=byOrder.get(url.searchParams.get("orderId"));check(order,"unknown order");
        if(url.pathname==="/api/v3/order")return Response.json(order);
        if(url.pathname==="/api/v3/myTrades")return Response.json([{id:order.orderId,orderId:order.orderId,qty:order.executedQty,quoteQty:order.cummulativeQuoteQty,
          commission:".00000001",commissionAsset:"BNB",isBuyer:false,time:now}]);
        throw new Error("OFFLINE_PROBE:unhandled path");
      }finally{active--;activeByPhase.set(phase,activeByPhase.get(phase)-1);}
    };
    const transport=engine=>new BinanceLiveTransport({apiKey:"offline-dummy-key",apiSecret:"offline-dummy-secret",engine,
      fetcher:(input,init)=>fetcher(input,init,engine.trading_engine_id),now:()=>now});
    let remainingStates=engines.length,releaseStates;
    const allStates=new Promise(resolve=>{releaseStates=resolve;});
    await shardedEngineMap(engines,item=>item.engine.executor_shard_id,4,async item=>{
      const shard=item.engine.executor_shard_id,engineId=item.engine.trading_engine_id;
      enginesActiveByShard.set(shard,(enginesActiveByShard.get(shard)??0)+1);
      enginesPeakByShard.set(shard,Math.max(enginesPeakByShard.get(shard)??0,enginesActiveByShard.get(shard)));
      phaseByEngine.set(engineId,"STATE");
      await transport(item.engine).safetySnapshot("SOLBRL");
      if(--remainingStates===0)releaseStates();
      // Synchronize the start of the measured order phase only. This is not a
      // runtime gate or concurrency cap; it forces the worst simultaneous start.
      await allStates;
      phaseByEngine.set(engineId,"ACKNOWLEDGED_SELL");
      let next=0;
      const engineConcurrency=item.engine.slot_count>25?4:1;
      await Promise.all(Array.from({length:engineConcurrency},async()=>{
        while(next<item.orders.length){
          const order=item.orders[next++],first=transport(item.engine);
          let observed,trades;
          if(item.engine.slot_count>25){
            check(typeof first.observeOwnedOrder==="function","order observation protocol unavailable");
            ({order:observed,trades}=await first.observeOwnedOrder("SOLBRL",order.clientOrderId,String(order.orderId)));
          }else{
            observed=await first.queryOrder("SOLBRL",order.clientOrderId,String(order.orderId));
            const second=transport(item.engine),confirmed=await second.queryOrder("SOLBRL",order.clientOrderId,String(order.orderId));
            trades=await second.ownedTrades("SOLBRL",order.clientOrderId,confirmed.orderId);
          }
          check(observed.status==="FILLED","not terminal");
          check(trades.length===1&&trades[0].quantity===Number(order.executedQty)
            &&trades[0].quoteQuantity===Number(order.cummulativeQuoteQty),"trade ownership/totals");closed++;
          closedByEngine.set(engineId,(closedByEngine.get(engineId)??0)+1);
        }
      }));
      enginesActiveByShard.set(shard,enginesActiveByShard.get(shard)-1);
      return engineId;
    },0);
    const last=engines[0].orders.at(-1);let foreignRejected=false;
    try{await transport(engines[1].engine).queryOrder("SOLBRL",last.clientOrderId,String(last.orderId));}
    catch(error){foreignRejected=error.code==="EXECUTOR_ORDER_NOT_OWNED";}
    check(foreignRejected,"foreign engine accepted");check(closed===count+50,"missing fills");check(active===0,"undrained queue");check(post===0,"write occurred");
    check(peakByPhase.get("ACKNOWLEDGED_SELL")===(count>25?6:3),"incorrect per-engine concurrency");
    for(const item of engines)check(closedByEngine.get(item.engine.trading_engine_id)===item.engine.slot_count,"sibling starvation");
    const cpu=process.cpuUsage(cpuBefore),rssAfter=process.memoryUsage().rss;
    results.push({slot_count:count,sibling_slot_counts:[25,25],synthetic_engines:3,reconciled_tp_observations:closed,
      observation_protocol:count>25?"ENGINE_ORDER_OBSERVATION_V1":"LEGACY_QUERY_TRADES",
      sibling_observation_protocols:["LEGACY_QUERY_TRADES","LEGACY_QUERY_TRADES"],
      target_slot_capital_brl:count===50?22:11,
      wall_ms:Number((performance.now()-started).toFixed(3)),cpu_user_ms:cpu.user/1000,cpu_system_ms:cpu.system/1000,
      rss_before_bytes:rssBefore,rss_after_bytes:rssAfter,process_peak_rss_bytes:process.resourceUsage().maxRSS*1024,
      max_inflight_gets:peak,state_peak_inflight_gets:peakByPhase.get("STATE"),acknowledged_sell_peak_inflight_gets:peakByPhase.get("ACKNOWLEDGED_SELL"),
      engine_worker_counts:[count>25?4:1,1,1],engines_peak_by_shard:Object.fromEntries(enginesPeakByShard),
      synchronized_order_phase_start:true,requests:requests.length,request_weight:requests.reduce((n,r)=>n+r.weight,0),
      private_weight:requests.filter(r=>r.host==="api.binance.com").reduce((n,r)=>n+r.weight,0),
      public_weight:requests.filter(r=>r.host==="data-api.binance.vision").reduce((n,r)=>n+r.weight,0),
      fixture_json_bytes:Buffer.byteLength(JSON.stringify([...byOrder.values()])),posts_or_deletes:post,
      foreign_engine_rejected:foreignRejected});
  }
  // Exercise the actual sharded scheduler's callback isolation, without any
  // transport or global rate limiter. Four blocked03 callbacks must not occupy
  // executor01's worker, and the fifth03 callback must wait for an actual slot.
  let releaseQueue;
  const held=new Promise(resolve=>{releaseQueue=resolve;}),queueActive=new Map(),queuePeak=new Map(),queueStarted=[],queueDone=[];
  const queueRows=Array.from({length:5},(_,i)=>({id:`03-${i}`,shard:"executor-03"})).concat({id:"01-0",shard:"executor-01"});
  const queueRunning=shardedEngineMap(queueRows,row=>row.shard,4,async row=>{
    queueStarted.push(row.id);queueActive.set(row.shard,(queueActive.get(row.shard)??0)+1);
    queuePeak.set(row.shard,Math.max(queuePeak.get(row.shard)??0,queueActive.get(row.shard)));
    if(row.shard==="executor-03")await held;
    queueDone.push(row.id);queueActive.set(row.shard,queueActive.get(row.shard)-1);return row.id;
  },0);
  for(let i=0;i<100&&!queueDone.includes("01-0");i++)await Promise.resolve();
  const otherShardCompletedBeforeRelease=queueDone.includes("01-0");
  const fifthWaitedBeforeRelease=!queueStarted.includes("03-4");
  releaseQueue();
  const queueOutput=await queueRunning;
  check(otherShardCompletedBeforeRelease,"cross-shard starvation");check(fifthWaitedBeforeRelease,"fifth engine bypassed shard cap");
  check(queuePeak.get("executor-03")===4,"canonical shard cap not exercised");
  check(JSON.stringify(queueOutput)===JSON.stringify(queueRows.map(row=>row.id)),"scheduler output misaligned");
  const resourceEnd=process.resourceUsage();
  return {contract:"COINOPS_OFFLINE_TRANSPORT_RESOURCE_V3",scope:"TRANSPORT_ONLY_NOT_FULL_STRATEGY_ENGINE",
    external_network_calls:0,environment_or_vault_reads:0,filesystem_writes:0,
    elapsed_ms:Number((performance.now()-wallStart).toFixed(3)),cpu_user_ms:(resourceEnd.userCPUTime-resourceStart.userCPUTime)/1000,
    cpu_system_ms:(resourceEnd.systemCPUTime-resourceStart.systemCPUTime)/1000,process_peak_rss_bytes:resourceEnd.maxRSS*1024,
    scenarios:results,queue_callbacks:{implementation:"CANONICAL_SHARDED_ENGINE_MAP",concurrency_per_shard:4,
      peak_by_shard:Object.fromEntries(queuePeak),other_shard_completed_before_release:otherShardCompletedBeforeRelease,
      fifth_engine_waited_for_slot:fifthWaitedBeforeRelease,output_alignment_preserved:true},
    limitations:["Synthetic Binance GET responses only","No SQL/web/registry latency or financial mutation",
      "Queue proof is canonical scheduler callbacks, not the complete LIVE cron","Not a Binance/IP throughput measurement"]};
}

export function renderSlotWorkloadResourceProbe(transportModuleUrl,slotCounts=[25,100]) {
  const url=new URL(transportModuleUrl);
  if(url.protocol!=="file:"||!url.pathname.endsWith("/apps/live-executor/src/binance-live.mjs"))throw new Error("OFFLINE_PROBE:public deployed transport required");
  if(!Array.isArray(slotCounts)||slotCounts.length<1||slotCounts.length>3
    ||new Set(slotCounts).size!==slotCounts.length||!slotCounts.every(count=>Number.isSafeInteger(count)&&count>=2&&count<=100))
    throw new Error("OFFLINE_PROBE:slot counts invalid");
  return `import { createHash } from "node:crypto";\n`+
    `globalThis.fetch=async()=>{throw new Error("OFFLINE_PROBE:external fetch forbidden")};\n`+
    `const {BinanceLiveTransport}=await import(${JSON.stringify(url.href)});\n`+
    `const {shardedEngineMap}=await import(${JSON.stringify(new URL("../../web/lib/execution/sharded-engine-map.ts",url).href)});\n`+
    `${runSlotWorkloadResourceProbe.toString()}\n`+
    `console.log(JSON.stringify(await runSlotWorkloadResourceProbe(BinanceLiveTransport,shardedEngineMap,${JSON.stringify(slotCounts)})));\n`;
}
