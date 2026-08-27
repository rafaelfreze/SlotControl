import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { ReportSlotRow } from "./report-export";

type CycleRow={id:string;cycle_number:number;mode:string;status:string;start_at:string;end_at:string|null;close_reason:string|null;redistribution_status:string;strategy_version_id:string};
type StrategyVersionRow={id:string;version:number;configuration:Record<string,unknown>};
type ProgressDbRow={asset:string;target:number|string;cycle_real_gains:number|string;cycle_redistribution_in:number|string;cycle_redistribution_out:number|string;cycle_external_gain_equivalent:number|string;cycle_progress:number|string;operational_value_start:number|string;entries_count:number;gains_count:number;slots:{slot_number:number;status:string;operational_slot_value:number|string}|null};
export async function loadCycleReport(reportId:string){
  const supabase=createClient();
  const{data:report,error}=await supabase.from("cycle_reports").select("id,cycle_id,baseline_id,strategy_version_id,status,report_version,payload,generated_at,finalized_at").eq("id",reportId).maybeSingle();
  if(error||!report)return{data:null,error:error?.message||"REPORT_NOT_FOUND"};
  const[{data:cycle,error:cycleError},{data:version,error:versionError},{data:progress,error:progressError}]=await Promise.all([
    supabase.from("operational_cycles").select("id,cycle_number,mode,status,start_at,end_at,close_reason,redistribution_status,strategy_version_id").eq("id",report.cycle_id).single(),
    supabase.from("strategy_versions").select("id,version,configuration").eq("id",report.strategy_version_id).single(),
    supabase.from("cycle_slot_progress").select("asset,target,cycle_real_gains,cycle_redistribution_in,cycle_redistribution_out,cycle_external_gain_equivalent,cycle_progress,operational_value_start,entries_count,gains_count,slots(slot_number,status,operational_slot_value)").eq("cycle_id",report.cycle_id).order("asset").order("cycle_progress",{ascending:false})
  ]);
  if(cycleError||versionError||progressError||!cycle||!version)return{data:null,error:cycleError?.message||versionError?.message||progressError?.message||"REPORT_INCOMPLETE"};
  const[{data:snapshots},{data:regimeEvents},{data:progressEvents}]=await Promise.all([
    supabase.from("cycle_daily_snapshots").select("snapshot_date,metrics").eq("cycle_id",report.cycle_id).order("snapshot_date"),
    supabase.from("strategy_regime_events").select("event_type,previous_mode,new_mode,btc_price,official_ath,defensive_anchor_ath,occurred_at").eq("baseline_id",report.baseline_id).gte("occurred_at",cycle.start_at).order("occurred_at"),
    supabase.from("cycle_progress_events").select("event_type,progress_delta,amount_usdt,occurred_at,slot_id").eq("cycle_id",report.cycle_id).order("occurred_at")
  ]);
  const rows=((progress||[])as unknown as ProgressDbRow[]).map((row):ReportSlotRow=>({asset:row.asset,slot_number:row.slots?.slot_number||0,status:row.slots?.status||"—",target:Number(row.target),cycle_real_gains:Number(row.cycle_real_gains),cycle_redistribution_in:Number(row.cycle_redistribution_in),cycle_redistribution_out:Number(row.cycle_redistribution_out),cycle_external_gain_equivalent:Number(row.cycle_external_gain_equivalent),cycle_progress:Number(row.cycle_progress),operational_value_start:Number(row.operational_value_start),operational_value_end:Number(row.slots?.operational_slot_value||0),entries_count:Number(row.entries_count),gains_count:Number(row.gains_count)}));
  return{data:{report,cycle:cycle as CycleRow,strategyVersion:version as StrategyVersionRow,rows,snapshots:snapshots||[],regimeEvents:regimeEvents||[],progressEvents:progressEvents||[]},error:null};
}