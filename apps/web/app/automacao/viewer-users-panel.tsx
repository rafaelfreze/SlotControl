"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type Viewer = { user_id: string; exchange_account_id: string | null; display_name: string;
  email: string; company_name: string | null; owner_name: string | null; whatsapp: string | null; status: string; created_at: string };
type Account = { id: string; display_name: string; status: string };
const viewerErrorMessage: Record<string, string> = {
  COINOPS_VIEWER_EMAIL_ALREADY_REGISTERED: "Este e-mail já possui cadastro. Use outro e-mail para o acesso exclusivo desta conta; nenhum vínculo novo foi criado.",
  COINOPS_VIEWER_ALREADY_EXISTS: "Este e-mail já tem acesso nesta operação. Confira a lista abaixo antes de criar outro convite.",
  COINOPS_VIEWER_CREATE_UNCONFIRMED: "A criação não foi confirmada. Confira a lista e tente novamente com os mesmos dados antes de cadastrar outro acesso.",
  COINOPS_VIEWER_CONTACT_INVALID: "Informe um WhatsApp válido com DDD.",
  COINOPS_VIEWER_PASSWORD_INVALID: "Informe uma senha com pelo menos 8 caracteres.",
  COINOPS_VIEWER_BINDING_FAILED: "O cadastro foi criado, mas o vínculo não foi confirmado. O acesso continua bloqueado; confira o cadastro antes de repetir.",
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
  const requestId = useRef<string | null>(null);
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
        body: JSON.stringify({ operation, requestId: operation === "CREATE_WITH_PASSWORD" ? (requestId.current ??= crypto.randomUUID()) : crypto.randomUUID(), ...extra }) });
      const body = await response.json();
      if (!response.ok) throw new Error(viewerErrorMessage[body.error] ?? body.error ?? "Ação não concluída");
      setMessage(operation === "CREATE_WITH_PASSWORD" ? "Cadastro criado. O cliente entra com o e-mail e a senha definidos, sem troca obrigatória. Após entrar, o cliente verá os primeiros passos; o vínculo da conta será feito depois." : operation === "CREATE" ? body.reusedAccess
        ? `Acesso recriado com a identidade original. Recuperação enviada para ${body.recipient}; use o e-mail mais recente. Nenhuma conta Binance ou motor foi recriado.`
        : "Convite enviado. O acesso é somente leitura e restrito à conta selecionada."
        : operation === "RESET" ? `Recuperação solicitada para ${body.recipient}. Confira a caixa de entrada e spam; use somente o e-mail mais recente. Isso não confirma recebimento na caixa postal.`
          : operation === "DELETE" ? "Acesso excluído da lista e mantido bloqueado. Auth, contas Binance, motores e histórico foram preservados."
          : operation === "ASSIGN" ? "Conta vinculada. Nenhum motor, capital ou operação foi ativado."
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
    void perform("CREATE_WITH_PASSWORD", { password: String(data.get("password") ?? ""),
      companyName: String(data.get("companyName") ?? ""), ownerName: String(data.get("ownerName") ?? ""),
      whatsapp: String(data.get("whatsapp") ?? ""), email: String(data.get("email") ?? "") })
      .then((created) => { if (created) { form.reset(); requestId.current = null; } });
  };
  return <section className="px-onboarding" aria-label="Usuários e acessos">
    <h2>Usuários / Acessos</h2>
    <p>Cadastre o cliente com os cinco dados abaixo. Ele entra diretamente para seguir o tutorial; a conta Binance será vinculada depois, pelo administrador.</p>
    <p>Para corrigir um cadastro, desative o acesso e corrija o vínculo ou exclua o acesso da lista. O e-mail e o histórico são preservados; nenhum dado da conta Binance ou dos motores é excluído.</p>
    <form className="px-onboarding-form" onSubmit={create}>
      <label>E-mail<input name="email" type="email" required autoComplete="email" /></label>
      <label>Senha inicial<input name="password" type="password" minLength={8} required autoComplete="new-password" placeholder="Mínimo 8 caracteres" /></label>
      <label>Nome da empresa<input name="companyName" minLength={2} maxLength={120} required autoComplete="organization" /></label>
      <label>Nome do dono<input name="ownerName" minLength={2} maxLength={120} required autoComplete="name" /></label>
      <label>WhatsApp<input name="whatsapp" type="tel" required autoComplete="tel" placeholder="DDD e número" /></label>
      <button className="px-button" type="submit" disabled={busy}>Criar cadastro</button>
    </form>
    <div className="px-onboarding-checks">{users.map((user) => <article key={user.user_id} className="px-viewer-row">
      <strong>{user.company_name || user.display_name}</strong><small>{user.owner_name || user.display_name} · {user.email}</small>
      <span>Conta: {user.exchange_account_id ? (accounts.find((account) => account.id === user.exchange_account_id)?.display_name ?? "Indisponível") : "Aguardando vínculo pelo administrador"} · Acesso {user.status}</span>
      <div className="px-account-actions">
        <button type="button" className="px-button" disabled={busy || user.status !== "ACTIVE"} onClick={() => void perform("RESET", { userId: user.user_id })}>Redefinir senha</button>
        {user.status === "ACTIVE" ? <><button type="button" className="px-button" disabled={busy} onClick={() => void perform("DISABLE", { userId: user.user_id })}>Desativar</button>
          <button type="button" className="px-button" disabled={busy} onClick={() => void perform("REVOKE", { userId: user.user_id })}>Revogar acesso</button></>
          : <><button type="button" className="px-button" disabled={busy} onClick={() => void perform("ENABLE", { userId: user.user_id })}>Reativar</button>
            <button type="button" className="px-button" disabled={busy} onClick={() => {
              if (window.confirm(`Excluir o acesso de ${user.email}? Ele ficará bloqueado e sairá da lista. O e-mail e a identidade Auth serão preservados. Nenhuma conta Binance, motor ou histórico será excluído.`))
                void perform("DELETE", { userId: user.user_id });
            }}>Excluir acesso</button></>}
      </div>
      {user.status === "ACTIVE" && !user.exchange_account_id ? <form className="px-onboarding-form" onSubmit={(event) => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        void perform("ASSIGN", { userId: user.user_id, accountId: String(data.get("accountId") ?? "") });
      }}>
        <label>Vincular conta depois do cadastro<select name="accountId" required defaultValue=""><option value="" disabled>Selecione uma conta</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.display_name} · {account.status}</option>)}</select></label>
        <button type="submit" className="px-button" disabled={busy || !accounts.length}>Vincular conta</button>
      </form> : null}
      {user.status !== "ACTIVE" ? <>
        <small>Acesso bloqueado. Não utilize convites antigos desta conta.</small>
        <form className="px-onboarding-form" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void perform("REASSIGN", { userId: user.user_id, accountId: String(data.get("accountId") ?? "") });
        }}>
          <label>Corrigir conta de {user.email}<select key={user.exchange_account_id} name="accountId" required defaultValue={user.exchange_account_id ?? ""}>
            {accounts.map((account) => <option value={account.id} key={account.id}>{account.display_name} · {account.status}</option>)}
          </select></label>
          <button type="submit" className="px-button" disabled={busy}>Corrigir vínculo · manter desativado</button>
        </form>
      </> : null}
    </article>)}{!users.length ? <p>Nenhum acesso de cliente criado.</p> : null}</div>
    {message && <p role="status">{message}</p>}
  </section>;
}
