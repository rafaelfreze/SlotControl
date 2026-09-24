"use client";

import { useEffect, useState, type FormEvent } from "react";

type Viewer = { user_id: string; exchange_account_id: string; display_name: string;
  email: string; status: string; created_at: string };
type Account = { id: string; display_name: string; status: string };

export function ViewerUsersPanel() {
  const [users, setUsers] = useState<Viewer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = async () => {
    const response = await fetch("/api/coinops-viewers", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("Acessos indisponíveis");
    const body = await response.json();
    setUsers(body.users ?? []); setAccounts(body.accounts ?? []);
  };
  useEffect(() => { void refresh().catch(() => setMessage("Não foi possível carregar os acessos.")); }, []);
  const perform = async (operation: string, extra: Record<string, string>) => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/coinops-viewers", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json", "x-coinops-admin-intent": "viewer-access" },
        body: JSON.stringify({ operation, requestId: crypto.randomUUID(), ...extra }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Ação não concluída");
      setMessage(operation === "CREATE" ? "Convite enviado. O acesso é somente leitura e restrito à conta selecionada."
        : operation === "RESET" ? "Instruções de nova senha enviadas por e-mail."
          : operation === "ENABLE" ? "Acesso reativado." : "Acesso bloqueado imediatamente no CoinOps.");
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Ação não concluída"); }
    finally { setBusy(false); }
  };
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void perform("CREATE", { displayName: String(data.get("displayName") ?? ""),
      email: String(data.get("email") ?? ""), accountId: String(data.get("accountId") ?? "") });
    form.reset();
  };
  return <section className="px-onboarding" aria-label="Usuários e acessos">
    <h2>Usuários / Acessos</h2>
    <p>Convide um proprietário para ver somente sua própria conta em Meu CoinOps. O convite usa Supabase Auth; nenhuma senha é salva no painel.</p>
    <form className="px-onboarding-form" onSubmit={create}>
      <label>Nome<input name="displayName" maxLength={80} required autoComplete="name" /></label>
      <label>E-mail<input name="email" type="email" maxLength={320} required autoComplete="email" /></label>
      <label>Conta Binance<select name="accountId" required defaultValue=""><option value="" disabled>Selecione uma conta</option>
        {accounts.map((account) => <option value={account.id} key={account.id}>{account.display_name} · {account.status}</option>)}</select></label>
      <p>Papel: VIEWER · somente leitura · uma conta</p>
      <button className="px-button" type="submit" disabled={busy || !accounts.length}>Criar acesso</button>
    </form>
    <div className="px-onboarding-checks">{users.map((user) => <article key={user.user_id} className="px-viewer-row">
      <strong>{user.display_name}</strong><small>{user.email}</small>
      <span>{accounts.find((account) => account.id === user.exchange_account_id)?.display_name ?? "Conta vinculada"} · {user.status}</span>
      <div className="px-account-actions">
        <button type="button" className="px-button" disabled={busy} onClick={() => void perform("RESET", { userId: user.user_id })}>Redefinir senha</button>
        {user.status === "ACTIVE" ? <><button type="button" className="px-button" disabled={busy} onClick={() => void perform("DISABLE", { userId: user.user_id })}>Desativar</button>
          <button type="button" className="px-button" disabled={busy} onClick={() => void perform("REVOKE", { userId: user.user_id })}>Revogar acesso</button></>
          : <button type="button" className="px-button" disabled={busy} onClick={() => void perform("ENABLE", { userId: user.user_id })}>Reativar</button>}
      </div>
    </article>)}{!users.length ? <p>Nenhum acesso de cliente criado.</p> : null}</div>
    {message && <p role="status">{message}</p>}
  </section>;
}
