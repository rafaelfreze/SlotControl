// Reproducible mechanical expansion of reviewed, existing transactional RPCs.
// It emits complete SQL definitions, never dynamic rewrites at migration time.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const dir=resolve(root,'supabase/migrations');
const target=resolve(dir,'20260924141913_add_multi_account_operator_engine_isolation.sql');
const read=n=>readFileSync(resolve(dir,n),'utf8').replace(/\r/g,'');
function fn(file,name){ const source=read(file),match=new RegExp(`create (?:or replace )?function (?:coinops|private)\\.${name}\\(`).exec(source);
 if(!match)throw Error(name); const end=source.indexOf('end $$;',match.index);
 if(end<0)throw Error(`End ${name}`); return source.slice(match.index,end+7).replace(/^create function/,'create or replace function'); }
function replace(s,a,b){if(!s.includes(a))throw Error(`Missing anchor: ${a.slice(0,120)}`);return s.replaceAll(a,()=>b);}
const live='20260924041046_add_robot_v1_live_execution_ledger.sql';
const manual='20260923231728_harden_robot_v1_manual_adjustments.sql';
let result=[];
for(const name of ['prepare_robot_v1_live_order','activate_robot_v1_live_cycle']){
 let s=fn(live,name);
 s=replace(s,'v_global coinops.robot_v1_live_global_caps%rowtype;','v_global coinops.account_quote_caps%rowtype;\n  v_engine coinops.trading_engines%rowtype;');
 s=replace(s,'select * into strict v_global from coinops.robot_v1_live_global_caps\n    where product_id=v_run.product_id and tenant_id=v_run.tenant_id and user_id=v_run.user_id for update;',
 `select * into strict v_engine from coinops.trading_engines where id=v_run.trading_engine_id for share;
  select * into strict v_global from coinops.account_quote_caps
    where exchange_account_id=v_run.exchange_account_id and quote_asset=v_run.quote_asset for update;`);
 s=replace(s,'and user_id=v_run.user_id and asset=v_run.asset','and user_id=v_run.user_id and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset');
 s=s.replaceAll('and a.user_id=v_run.user_id and a.asset=v_run.asset','and a.user_id=v_run.user_id and a.trading_engine_id=v_run.trading_engine_id and a.asset=v_run.asset');
 s=s.replaceAll('and r.user_id=v_run.user_id and r.asset=v_run.asset','and r.user_id=v_run.user_id and r.trading_engine_id=v_run.trading_engine_id and r.asset=v_run.asset');
 s=s.replaceAll("and r.user_id=v_run.user_id and r.status", "and r.user_id=v_run.user_id and r.exchange_account_id=v_run.exchange_account_id and r.quote_asset=v_run.quote_asset and r.status");
 s=s.replaceAll('v_global.max_total_live_exposure_brl','v_global.hard_cap_quote');
 // Retain exact Rafael ceilings while non-legacy engines use explicit native caps.
 s=s.replace(/v_config\.configured_live_capital_brl\s*>\s*\(case v_run\.asset when 'BTC' then 450 else 275 end\)/g,
  "v_config.configured_live_capital_brl > least(v_engine.hard_cap_quote,case when v_engine.legacy_compatible then case v_run.asset when 'BTC' then 450 else 275 end else v_engine.hard_cap_quote end)");
 s=s.replace(/v_config\.max_order_notional_brl\s*>\s*\(case v_run\.asset when 'BTC' then 18 else 11 end\)/g,
  "v_config.max_order_notional_brl > (case when v_engine.legacy_compatible then case v_run.asset when 'BTC' then 18 else 11 end else v_engine.hard_cap_quote end)");
 s=s.replace(/v_config\.max_total_exposure_brl\s*>\s*\(case v_run\.asset when 'BTC' then 450 else 275 end\)/g,
  "v_config.max_total_exposure_brl > least(v_engine.hard_cap_quote,case when v_engine.legacy_compatible then case v_run.asset when 'BTC' then 450 else 275 end else v_engine.hard_cap_quote end)");
 s=s.replace(/v_global\.hard_cap_quote\s*>\s*725/g,'(v_engine.legacy_compatible and v_global.hard_cap_quote > 725)');
 if(name==='prepare_robot_v1_live_order') s=replace(s,"if p_side='BUY' then",`if p_side='BUY' then
    if v_engine.status<>'ACTIVE' or v_engine.kill_switch
      or exists(select 1 from coinops.exchange_accounts a where a.id=v_run.exchange_account_id and (a.status<>'ACTIVE' or a.kill_switch))
      or exists(select 1 from coinops.operators o where o.id=v_run.operator_id and (o.status<>'ACTIVE' or o.kill_switch)) then
      raise exception 'COINOPS_ENGINE_NEW_WRITES_BLOCKED'; end if;`);
 else s=replace(s,"if v_run.status='ACTIVE'",`if v_engine.status<>'ACTIVE' or v_engine.kill_switch
      or exists(select 1 from coinops.exchange_accounts a where a.id=v_run.exchange_account_id and (a.status<>'ACTIVE' or a.kill_switch))
      or exists(select 1 from coinops.operators o where o.id=v_run.operator_id and (o.status<>'ACTIVE' or o.kill_switch)) then
      raise exception 'COINOPS_ENGINE_NEW_WRITES_BLOCKED'; end if;
  if v_run.status='ACTIVE'`);
 if(name==='prepare_robot_v1_live_order')s=replace(s,"p_client_order_id !~ ('^COR1-'||v_run.asset||'-'||v_slot.slot_number||'-'||p_revision||'-'||p_side||'-[a-f0-9]{14}$')",
  "(case when v_engine.legacy_compatible then p_client_order_id !~ ('^COR1-'||v_run.asset||'-'||v_slot.slot_number||'-'||p_revision||'-'||p_side||'-[a-f0-9]{14}$') else p_client_order_id !~ ('^C2-'||substr(encode(sha256(convert_to(v_run.exchange_account_id::text||'|'||v_run.trading_engine_id::text,'UTF8')),'hex'),1,10)||'-'||v_slot.slot_number||'-'||substr(p_side,1,1)||'-[a-f0-9]{14}$') end)");
 result.push(s);
}
let s=fn(live,'sync_robot_v1_live_order');
s=replace(s,'on conflict (symbol,exchange_trade_id) do nothing;','on conflict (exchange_account_id,symbol,exchange_trade_id) do nothing;');
s=replace(s,'where symbol=v_run.symbol and exchange_trade_id=v_trade_id;',
 'where exchange_account_id=v_run.exchange_account_id and symbol=v_run.symbol and exchange_trade_id=v_trade_id;');
s=s.replaceAll("commission_asset in ('BNB','BRL')","commission_asset in ('BNB',v_run.quote_asset)").replaceAll("commission_asset='BRL'","commission_asset=v_run.quote_asset");
s=replace(s,"v_fee_asset not in (v_run.asset,'BRL','BNB')","v_fee_asset not in (v_run.asset,v_run.quote_asset,'BNB')");
s=replace(s,"v_fee_asset='BRL'","v_fee_asset=v_run.quote_asset");
s=replace(s,"'BINANCE_SPOT_BNBBRL_TICKER'","'BINANCE_SPOT_BNB'||v_run.quote_asset||'_TICKER'");
result.push(s);
s=fn(live,'credit_robot_v1_live_closed_slot');
s=replace(s,'and user_id=v_run.user_id and asset=v_run.asset','and user_id=v_run.user_id and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset');
s=s.replaceAll('and asset=v_run.asset and slot_number=v_slot.slot_number','and trading_engine_id=v_run.trading_engine_id and asset=v_run.asset and slot_number=v_slot.slot_number');
s=s.replaceAll('and trading_engine_id=v_run.trading_engine_id and trading_engine_id=v_run.trading_engine_id','and trading_engine_id=v_run.trading_engine_id');
s=replace(s,"f.commission_asset in ('BNB','BRL')","f.commission_asset in ('BNB',v_run.quote_asset)");
result.push(s);
s=fn(live,'restart_robot_v1_live_cycle');
s=s.replaceAll('and user_id=v_old.user_id and asset=v_old.asset','and user_id=v_old.user_id and trading_engine_id=v_old.trading_engine_id and asset=v_old.asset');
// Any new run has explicit parent-engine identity, not the legacy asset bridge.
s=replace(s,'insert into coinops.robot_v1_live_runs\n    (','insert into coinops.robot_v1_live_runs\n    (operator_id,exchange_account_id,trading_engine_id,quote_asset,');
const insertAt=s.indexOf('insert into coinops.robot_v1_live_runs');
const valuesAt=s.indexOf('values (',insertAt);
if(valuesAt<0)throw Error('Live restart values');
s=s.slice(0,valuesAt)+s.slice(valuesAt).replace('values (','values (v_old.operator_id,v_old.exchange_account_id,v_old.trading_engine_id,v_old.quote_asset,');
result.push(s);
s=fn('20260923231731_harden_robot_v1_testnet_partial_accounting.sql','restart_robot_v1_testnet_cycle_v2');
s=replace(s,'where reset_idempotency_key=p_reset_idempotency_key;',
 'where previous_run_id=p_old_run_id and reset_idempotency_key=p_reset_idempotency_key;');
s=replace(s,'and g.user_id=v_old.user_id and g.asset=v_old.asset','and g.user_id=v_old.user_id and g.trading_engine_id=v_old.trading_engine_id and g.asset=v_old.asset');
s=replace(s,"not ((v_old.asset='BTC' and v_old.symbol='BTCUSDC') or (v_old.asset='SOL' and v_old.symbol='SOLUSDC'))",
 "not exists(select 1 from coinops.trading_engines e where e.id=v_old.trading_engine_id and e.environment='TESTNET' and e.symbol=v_old.symbol and e.base_asset=v_old.asset)");
s=replace(s,'insert into coinops.robot_v1_testnet_runs(','insert into coinops.robot_v1_testnet_runs(operator_id,exchange_account_id,trading_engine_id,quote_asset,');
const start=s.indexOf('insert into coinops.robot_v1_testnet_runs'), val=s.indexOf('values(',start);
if(val<0)throw Error('Testnet restart values');
s=s.slice(0,val)+s.slice(val).replace('values(','values(v_old.operator_id,v_old.exchange_account_id,v_old.trading_engine_id,v_old.quote_asset,');
result.push(s);
result.push(`create or replace function coinops.restart_robot_v1_testnet_cycle(
 p_old_run_id uuid,p_terminal_fill_client_order_id text,p_anchor_price numeric,p_price_tick numeric,
 p_reset_idempotency_key text,p_recovery_source text,p_reset_started_at timestamptz
) returns table(new_run_id uuid,created boolean) language plpgsql security definer set search_path='' as $$begin
 if not exists(select 1 from coinops.robot_v1_testnet_runs r
   join coinops.trading_engines e on e.id=r.trading_engine_id
   join coinops.exchange_accounts a on a.id=e.exchange_account_id
   where r.id=p_old_run_id and e.legacy_compatible and a.is_legacy_default) then
   raise exception 'COINOPS_LEGACY_ENGINE_REQUIRED';end if;
 return query select * from coinops.restart_robot_v1_testnet_cycle_v2(p_old_run_id,p_terminal_fill_client_order_id,
   p_anchor_price,p_price_tick,p_reset_idempotency_key,p_recovery_source,p_reset_started_at);
end $$;`);
s=fn('20260923221727_add_robot_v1_manual_slot_adjustments.sql','rank_robot_v1_testnet_fresh_cycle');
s=replace(s,'gain.asset = v_run.asset','gain.trading_engine_id = v_run.trading_engine_id and gain.asset = v_run.asset');
result.push(s);

// New manual signature explicitly selects the immutable engine. Original
// accounting, snapshot, FX, lease, reversal and idempotency checks stay intact.
s=fn(manual,'apply_robot_v1_manual_adjustment');
s=replace(s,'p_expected_balance numeric, p_expected_lifetime integer, p_expected_monthly integer',
 'p_expected_balance numeric, p_expected_lifetime integer, p_expected_monthly integer, p_trading_engine_id uuid');
s=replace(s,'declare\n  v_existing','declare\n  v_engine coinops.trading_engines%rowtype;\n  v_existing');
s=replace(s,"  v_fingerprint := md5",`  if p_trading_engine_id is null then raise exception 'COINOPS_ENGINE_SCOPE_DENIED'; end if;
  v_engine:=private.coinops_resolve_engine(p_product_id,p_tenant_id,p_user_id,p_environment,p_asset,p_trading_engine_id,null);
  if p_environment='REAL' or v_engine.quote_asset not in ('USDC','USDT') then raise exception 'COINOPS_REAL_BRL_ADJUSTMENT_NOT_ENABLED'; end if;
  v_fingerprint := md5`);
// Preserve legacy request fingerprints to recover pre-migration retries.
s=replace(s,"'reversal_of',p_reversal_of)::text);",`'reversal_of',p_reversal_of)::text);
  if not v_engine.legacy_compatible then v_fingerprint:=md5(v_engine.id::text||':'||v_fingerprint); end if;`);
s=replace(s,'and user_id=p_user_id','and user_id=p_user_id and trading_engine_id=v_engine.id');
s=replace(s,"p_environment || ':' || p_asset || ':' || p_slot_number", "v_engine.id::text || ':' || p_slot_number");
s=replace(s,"v_fx_source is distinct from 'BINANCE_SPOT_USDCBRL_ASK'", "v_fx_source is distinct from ('BINANCE_SPOT_'||v_engine.quote_asset||'BRL_ASK')");
s=replace(s,'(product_id,tenant_id,user_id,created_by,environment,asset,slot_number,physical_slot_id,',
 '(operator_id,exchange_account_id,trading_engine_id,quote_asset,product_id,tenant_id,user_id,created_by,environment,asset,slot_number,physical_slot_id,');
s=replace(s,'values (p_product_id,p_tenant_id,p_user_id,p_created_by,p_environment,p_asset,p_slot_number,v_physical,',
 'values (v_engine.operator_id,v_engine.exchange_account_id,v_engine.id,v_engine.quote_asset,p_product_id,p_tenant_id,p_user_id,p_created_by,p_environment,p_asset,p_slot_number,v_physical,');
// REAL old branch is deliberately unreachable; update its conflict target too.
s=s.replaceAll('on conflict (product_id,tenant_id,user_id,asset,slot_number)','on conflict (trading_engine_id,slot_number)');
result.push(s);
const sig='uuid,uuid,uuid,uuid,text,text,integer,text,integer,text,numeric,numeric,text,timestamptz,text,text,uuid,text,numeric,integer,integer,uuid';
result.push(`revoke all on function coinops.apply_robot_v1_manual_adjustment(${sig}) from public,anon,authenticated;
grant execute on function coinops.apply_robot_v1_manual_adjustment(${sig}) to service_role;`);
const old=fn(manual,'apply_robot_v1_manual_adjustment');
const header=old.slice(0,old.indexOf('declare'));
result.push(`${header}declare e coinops.trading_engines%rowtype; begin
 e:=private.coinops_resolve_engine(p_product_id,p_tenant_id,p_user_id,p_environment,p_asset,null,null);
 return coinops.apply_robot_v1_manual_adjustment(p_product_id,p_tenant_id,p_user_id,p_created_by,
  p_environment,p_asset,p_slot_number,p_kind,p_gain_units,p_currency,p_original_amount,
  p_fx_rate,p_fx_source,p_fx_observed_at,p_reason,p_note,p_reversal_of,p_idempotency_key,
  p_expected_balance,p_expected_lifetime,p_expected_monthly,e.id);
end $$;`);

// Audit preparation events inherit context directly, avoiding old-user+asset
// fallback when a non-legacy engine's settings are saved.
s=fn('20260924001657_add_robot_v1_live_brl_preparation.sql','audit_robot_v1_live_preparation');
s=replace(s,'(product_id,tenant_id,user_id,asset,config_version,event_type,snapshot)',
 '(operator_id,exchange_account_id,trading_engine_id,quote_asset,product_id,tenant_id,user_id,asset,config_version,event_type,snapshot)');
s=replace(s,'values (new.product_id,new.tenant_id,new.user_id,',
 'values (new.operator_id,new.exchange_account_id,new.trading_engine_id,new.quote_asset,new.product_id,new.tenant_id,new.user_id,');
result.push(s);
const marker='-- RPC DEFINITIONS APPENDED BELOW BEFORE COMMIT.';
const foundation=readFileSync(target,'utf8').split(marker)[0];
writeFileSync(target,foundation+marker+'\n\n'+result.join('\n\n')+'\n\ncommit;\n');
console.log(`Generated ${result.length} scoped RPC definitions`);
