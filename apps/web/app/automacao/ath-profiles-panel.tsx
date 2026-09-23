import { MONTHLY_SLOT_TARGET } from "@/lib/execution/monthly-slot-policy";

import { saveAthNextProfile } from "./ath-config-actions";

type Profile = {
  id: string; environment: "SHADOW" | "TESTNET" | "REAL"; asset: "BTC" | "SOL";
  config_version: number; gain_rate: number | string; normal_spacing_rate: number | string;
  post_ath_spacing_rate: number | string; next_config_version: number | null;
  next_gain_rate: number | string | null; next_normal_spacing_rate: number | string | null;
  next_post_ath_spacing_rate: number | string | null;
  regime: "NORMAL" | "POST_ATH"; ath_price: number | string | null;
  ath_observed_at: string | null; ath_source: string | null; ath_verified_at: string | null;
  ath_floor_reference: number | string | null; ath_floor_source: string | null;
};
type SlotRow = { environment: "SHADOW" | "TESTNET"; asset: "BTC" | "SOL";
  physicalSlotNumber: number; physicalSlotId: string; lifetimeGains: number;
  monthlyGains: number | null; monthlyTarget: number; balanceUsdc: number;
  eligible: boolean; operationalRank: number | null; group: "PRIMARY" | "RESERVE" | null;
  groupRank: number | null; status: string; buyPrice: number };
const pct = (rate: number | string | null) => rate === null ? "—" : `${(Number(rate) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 4 })}%`;
const inputPct = (rate: number | string | null) => rate === null ? "" : (Number(rate) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 4 });

export function AthProfilesPanel({ profiles, slots, marketPrices, view }: { profiles: Profile[];
  slots: SlotRow[]; marketPrices: Record<"BTC" | "SOL", number | null>;
  view: "overview" | "shadow" | "testnet" | "live" }) {
  if (view === "overview") return null;
  const environment = view === "shadow" ? "SHADOW" : view === "testnet" ? "TESTNET" : "REAL";
  return <section className="ath-profiles"><header><div><span>ESTRATÉGIA 4.3</span><h2>Regime ATH e percentuais · {environment}</h2></div><a href="/automacao/simulador-ath">Simular cenário ATH →</a></header>
    <div className="ath-profiles-grid">{(["BTC", "SOL"] as const).map((asset) => {
      const profile = profiles.find((item) => item.environment === environment && item.asset === asset);
      if (!profile) return <p key={asset} className="ath-profile-missing">{asset}: perfil ATH ainda não disponível.</p>;
      const post = profile.regime === "POST_ATH";
      const currentSlots = slots.filter((slot) => slot.environment === environment && slot.asset === asset);
      const primary = currentSlots.filter((slot) => slot.group === "PRIMARY");
      const reserve = currentSlots.filter((slot) => slot.group === "RESERVE");
      const available = (rows: SlotRow[]) => rows.filter((slot) => slot.eligible
        && ["PLANNED", "PENDING", "NONE"].includes(slot.status)).length;
      const floorDistance = profile.ath_floor_reference && marketPrices[asset]
        ? (marketPrices[asset]! / Number(profile.ath_floor_reference) - 1) * 100 : null;
      return <details key={profile.id} className="ath-profile-card"><summary><strong>{asset} · {post ? "REGIME PÓS-ATH" : "NORMAL"}</strong><span>{pct(profile.gain_rate)} gain · {pct(post ? profile.post_ath_spacing_rate : profile.normal_spacing_rate)} queda ativa · v{profile.config_version}</span></summary>
        <div className="ath-profile-body"><p>ATH confirmado: {profile.ath_price ?? "Ainda sem baseline histórico"} · {profile.ath_observed_at ?? "—"}</p>
          <p>Fonte: {profile.ath_source ?? "Ainda não confirmada"} · verificação {profile.ath_verified_at ?? "pendente"}</p>
          <p>Floor: {profile.ath_floor_reference ?? "Referência de retorno ainda não definida"}{profile.ath_floor_source ? ` · ${profile.ath_floor_source}` : ""}</p>
          {floorDistance !== null ? <p>Distância ao floor pelo último preço Production consultado: {floorDistance.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%.</p> : null}
          <p>Atual: gain {pct(profile.gain_rate)} · queda normal {pct(profile.normal_spacing_rate)} · queda pós-ATH {pct(profile.post_ath_spacing_rate)} · meta {MONTHLY_SLOT_TARGET[asset]}/slot/mês · 25 slots.</p>
          {post ? <p>Primary: {primary.length} selecionados · {available(primary)} disponíveis. Reserve: {reserve.length} selecionados · {available(reserve)} disponíveis.</p> : null}
          {profile.next_config_version ? <p>Próximo ciclo preparado: v{profile.next_config_version} · gain {pct(profile.next_gain_rate)} · normal {pct(profile.next_normal_spacing_rate)} · pós-ATH {pct(profile.next_post_ath_spacing_rate)}.</p> : null}
          {environment === "REAL" ? <p className="ath-profile-live-blocked">CONFIGURAÇÃO PREPARADA — LIVE BLOQUEADO. Binance Production somente leitura.</p> : null}
          <form action={saveAthNextProfile}><input type="hidden" name="environment" value={environment} /><input type="hidden" name="asset" value={asset} />
            <label>Gain %<input name="gain_percent" type="text" inputMode="decimal" defaultValue={inputPct(profile.next_gain_rate ?? profile.gain_rate)} required /></label>
            <label>Queda normal %<input name="normal_spacing_percent" type="text" inputMode="decimal" defaultValue={inputPct(profile.next_normal_spacing_rate ?? profile.normal_spacing_rate)} required /></label>
            <label>Queda pós-ATH %<input name="post_ath_spacing_percent" type="text" inputMode="decimal" defaultValue={inputPct(profile.next_post_ath_spacing_rate ?? profile.post_ath_spacing_rate)} required /></label>
            <label>Floor manual (opcional)<input name="ath_floor_reference" type="text" inputMode="decimal" placeholder={profile.ath_floor_reference?.toString() ?? "Ainda não definido"} /></label>
            <button type="submit">Salvar para próximo ciclo</button>
          </form>
          {currentSlots.length ? <details className="ath-slot-list"><summary>Ver slots, grupo e próxima ação ({currentSlots.length})</summary><div className="ath-slot-table-wrap"><table><thead><tr><th>Físico</th><th>Rank</th><th>Gains</th><th>Grupo</th><th>Status</th><th>Saldo</th><th>Próxima ação</th></tr></thead><tbody>{currentSlots
            .sort((left, right) => (left.operationalRank ?? 99) - (right.operationalRank ?? 99)
              || left.physicalSlotNumber - right.physicalSlotNumber).map((slot) => <tr key={slot.physicalSlotId}>
              <td title={slot.physicalSlotId}>#{slot.physicalSlotNumber}</td><td>{slot.operationalRank ?? "—"}</td>
              <td>{slot.lifetimeGains} total · {slot.monthlyGains ?? "?"}/{slot.monthlyTarget} mês</td>
              <td>{slot.group ? `${slot.group} #${slot.groupRank}` : "—"}</td><td>{slot.status}</td>
              <td>{slot.balanceUsdc.toLocaleString("pt-BR", { maximumFractionDigits: 4 })} USDC</td>
              <td>{slot.monthlyGains !== null && slot.monthlyGains >= slot.monthlyTarget ? "META BATIDA — aguardar mês"
                : ["OPEN", "TP_ACTIVE"].includes(slot.status) ? "Aguardar TP"
                  : slot.status === "ARMED" ? `Próxima BUY ${slot.buyPrice || "—"}`
                    : slot.eligible ? `Aguardar preço ${slot.buyPrice || "—"}` : "Bloqueado"}</td>
            </tr>)}</tbody></table></div></details> : null}
        </div></details>;
    })}</div>
  </section>;
}
