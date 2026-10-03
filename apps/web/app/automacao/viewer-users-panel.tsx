"use client";

import { useEffect, useState, type FormEvent } from "react";

type Viewer = { user_id: string; exchange_account_id: string; display_name: string;
  email: string; status: string; created_at: string };
type Account = { id: string; display_name: string; status: string };
const viewerErrorMessage: Record<string, string> = {
  COINOPS_VIEWER_EMAIL_ALREADY_REGISTERED: "Este e-mail já possui cadastro. Use outro e-mail para o acesso exclusivo desta conta; nenhum vínculo novo foi criado.",
  COINOPS_VIEWER_ALREADY_EXISTS: "Este e-mail já tem acesso nesta operação. Confira a lista abaixo antes de criar outro convite.",
  COINOPS_VIEWER_INVITE_FAILED: "Não foi possível enviar o convite. Nenhum acesso novo foi criado; tente novamente mais tarde.",
  COINOPS_VIEWER_RESET_REQUIRES_ACTIVE: "Este acesso está desativado. Confira e corrija a conta vinculada antes de reativá-lo; convites antigos não funcionam.",
  COINOPS_VIEWER_RESET_FAILED: "O envio de recuperação não foi confirmado. Nenhum vínculo foi alterado; tente novamente mais tarde.",
  COINOPS_VIEWER_RESET_RATE_LIMIT: "O Auth limitou o envio. Aguarde antes de pedir outro link e confira o último e-mail recebido.",
  COINOPS_VIEWER_REASSIGN_REQUIRES_INACTIVE: "Desative este acesso antes de corrigir a conta vinculada.",
  COINOPS_VIEWER_BINDING_CHANGED: "O vínculo mudou durante a operação. Atualize a lista e confira a conta antes de tentar novamente.",
  COINOPS_VIEWER_RESTORE_IDENTITY_DENIED: "Não foi possível comprovar que esta identidade é o acesso de visualização original. Nenhum usuário Auth foi alterado.",
  COINOPS_VIEWER_RESTORE_ROLLBACK_FAILED: "A recuperação não foi concluída e exige conferir o estado do vínculo. Não crie outro usuário nem repita o envio sem verificar.",
};

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
      if (!response.ok) throw new Error(viewerErrorMessage[body.error] ?? body.error ?? "Ação não concluída");
      setMessage(operation === "CREATE" ? body.reusedAccess
        ? `Acesso recriado com a identidade original. Recuperação enviada para ${body.recipient}; use o e-mail mais recente. Nenhuma conta Binance ou motor foi recriado.`
        : "Convite enviado. O acesso é somente leitura e restrito à conta selecionada."
        : operation === "RESET" ? `Recuperação solicitada para ${body.recipient}. Confira a caixa de entrada e spam; use somente o e-mail mais recente. Isso não confirma recebimento na caixa postal.`
          : operation === "DELETE" ? "Acesso excluído da lista e mantido bloqueado. Você pode criar acesso novamente com o mesmo e-mail. Auth, contas Binance, motores e histórico foram preservados."
          : operation === "REASSIGN" ? "Conta vinculada corrigida. O acesso continua desativado; confira a conta antes de reativar e enviar um novo link."
          : operation === "ENABLE" ? "Acesso reativado." : "Acesso bloqueado imediatamente no CoinOps.");
      await refresh();
      return true;
    } catch (error) { setMessage(error instanceof Error ? error.message : "Ação não concluída"); }
    finally { setBusy(false); }
    return false;
  };
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void perform("CREATE", { displayName: String(data.get("displayName") ?? ""),
      email: String(data.get("email") ?? ""), accountId: String(data.get("accountId") ?? "") })
      .then((created) => { if (created) form.reset(); });
  };
  return <section className="px-onboarding" aria-label="Usuários e acessos">
    <h2>Usuários / Acessos</h2>
    <p>Convide um proprietário para ver somente sua própria conta em Meu CoinOps. O convite usa Supabase Auth; nenhuma senha é salva no painel.</p>
    <p>Para corrigir um cadastro, desative o acesso e corrija o vínculo ou exclua o acesso da lista. Você pode cadastrá-lo novamente com o mesmo e-mail; isso não exclui a conta Binance, motores ou histórico.</p>
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
      <span>Conta vinculada: {accounts.find((account) => account.id === user.exchange_account_id)?.display_name ?? "Indisponível"} · Acesso {user.status}</span>
      <div className="px-account-actions">
        <button type="button" className="px-button" disabled={busy || user.status !== "ACTIVE"} onClick={() => void perform("RESET", { userId: user.user_id })}>Redefinir senha</button>
        {user.status === "ACTIVE" ? <><button type="button" className="px-button" disabled={busy} onClick={() => void perform("DISABLE", { userId: user.user_id })}>Desativar</button>
          <button type="button" className="px-button" disabled={busy} onClick={() => void perform("REVOKE", { userId: user.user_id })}>Revogar acesso</button></>
          : <><button type="button" className="px-button" disabled={busy} onClick={() => void perform("ENABLE", { userId: user.user_id })}>Reativar</button>
            <button type="button" className="px-button" disabled={busy} onClick={() => {
              if (window.confirm(`Excluir o acesso de ${user.email}? Ele ficará bloqueado e sairá da lista. Você poderá cadastrá-lo novamente com o mesmo e-mail. Nenhuma conta Binance, motor ou histórico será excluído.`))
                void perform("DELETE", { userId: user.user_id });
            }}>Excluir acesso</button></>}
      </div>
      {user.status !== "ACTIVE" ? <>
        <small>Acesso bloqueado. Não utilize convites antigos desta conta.</small>
        <form className="px-onboarding-form" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void perform("REASSIGN", { userId: user.user_id, accountId: String(data.get("accountId") ?? "") });
        }}>
          <label>Corrigir conta de {user.email}<select key={user.exchange_account_id} name="accountId" required defaultValue={user.exchange_account_id}>
            {accounts.map((account) => <option value={account.id} key={account.id}>{account.display_name} · {account.status}</option>)}
          </select></label>
          <button type="submit" className="px-button" disabled={busy}>Corrigir vínculo · manter desativado</button>
        </form>
      </> : null}
    </article>)}{!users.length ? <p>Nenhum acesso de cliente criado.</p> : null}</div>
    {message && <p role="status">{message}</p>}
  </section>;
}
