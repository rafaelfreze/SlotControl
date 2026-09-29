import type { PremiumAccount, PremiumEngine } from "./premium-operator";

export type AccountOperationalState = "CRITICAL" | "ALERT" | "RECOVERING" | "OPERATIONAL" | "INACTIVE";
export type AccountOption = PremiumAccount & { state: AccountOperationalState; markets: string[] };

const priority: Record<AccountOperationalState, number> = {
  CRITICAL: 0, ALERT: 1, RECOVERING: 2, OPERATIONAL: 3, INACTIVE: 4,
};

export const accountStateLabel: Record<AccountOperationalState, string> = {
  CRITICAL: "Crítico ou bloqueado", ALERT: "Atenção", RECOVERING: "Em recuperação",
  OPERATIONAL: "Operacional", INACTIVE: "Inativa",
};

/** Derive selector state from the same server-scoped registry and engine health used by the cards. */
export function accountOptions(accounts: PremiumAccount[], engines: PremiumEngine[]): AccountOption[] {
  const byAccount = new Map<string, PremiumEngine[]>();
  for (const engine of engines) {
    const rows = byAccount.get(engine.accountId) ?? [];
    rows.push(engine);
    byAccount.set(engine.accountId, rows);
  }
  return accounts.map((account) => {
    const rows = byAccount.get(account.id) ?? [];
    const markets = [...new Set(rows.map((row) => row.symbol))];
    const blocked = account.killSwitch || rows.some((row) => row.killSwitch
      || /BLOCKED|CRITICAL|PROTECTED|PROTEGIDO/i.test(`${row.engineStatus} ${row.health.label}`));
    const recovering = rows.some((row) => /RECOVERING|RECUPER/i.test(`${row.engineStatus} ${row.health.label}`));
    const alert = rows.some((row) => row.activeIssueCount > 0
      || !row.health.healthy && !/RECOVERING|RECUPER/i.test(`${row.engineStatus} ${row.health.label}`));
    const inactive = account.status !== "ACTIVE" || rows.length === 0 || rows.every((row) => row.engineStatus === "PAUSED");
    const state: AccountOperationalState = blocked ? "CRITICAL" : alert ? "ALERT"
      : recovering ? "RECOVERING" : inactive ? "INACTIVE" : "OPERATIONAL";
    return { ...account, state, markets };
  }).sort((a, b) => priority[a.state] - priority[b.state]
    || a.displayName.localeCompare(b.displayName, "pt-BR") || a.id.localeCompare(b.id));
}

const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");

export function searchAccountOptions(options: AccountOption[], query: string): AccountOption[] {
  const needle = normalize(query.trim());
  return needle ? options.filter((option) => normalize(`${option.displayName} ${option.id} ${option.markets.join(" ")}`).includes(needle)) : options;
}
