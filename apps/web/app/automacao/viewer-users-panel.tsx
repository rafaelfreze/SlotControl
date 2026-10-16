"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import "./viewer-users-panel.css";

type Viewer = {
  user_id: string;
  exchange_account_id: string | null;
  display_name: string;
  email: string;
  company_name: string | null;
  owner_name: string | null;
  whatsapp: string | null;
  status: string;
  created_at: string;
};
type Account = { id: string; display_name: string; status: string };
const viewerErrorMessage: Record<string, string> = {
  COINOPS_VIEWER_EMAIL_ALREADY_REGISTERED:
    "Este e-mail já possui cadastro. Use outro e-mail para o acesso exclusivo desta conta; nenhum vínculo novo foi criado.",
  COINOPS_VIEWER_ALREADY_EXISTS:
    "Este e-mail já tem acesso nesta operação. Confira a lista abaixo antes de criar outro convite.",
  COINOPS_VIEWER_CREATE_UNCONFIRMED:
    "A criação não foi confirmada. Confira a lista e tente novamente com os mesmos dados antes de cadastrar outro acesso.",
  COINOPS_VIEWER_CONTACT_INVALID: "Informe um WhatsApp válido com DDD.",
  COINOPS_VIEWER_PASSWORD_INVALID:
    "Informe uma senha com pelo menos 8 caracteres.",
  COINOPS_VIEWER_BINDING_FAILED:
    "O cadastro foi criado, mas o vínculo não foi confirmado. O acesso continua bloqueado; confira o cadastro antes de repetir.",
  COINOPS_VIEWER_INVITE_FAILED:
    "Não foi possível enviar o convite. Nenhum acesso novo foi criado; tente novamente mais tarde.",
  COINOPS_VIEWER_RESET_REQUIRES_ACTIVE:
    "Este acesso está desativado. Confira e corrija a conta vinculada antes de reativá-lo; convites antigos não funcionam.",
  COINOPS_VIEWER_RESET_FAILED:
    "O envio de recuperação não foi confirmado. Nenhum vínculo foi alterado; tente novamente mais tarde.",
  COINOPS_VIEWER_RESET_RATE_LIMIT:
    "O Auth limitou o envio. Aguarde antes de pedir outro link e confira o último e-mail recebido.",
  COINOPS_VIEWER_REASSIGN_REQUIRES_INACTIVE:
    "Desative este acesso antes de corrigir a conta vinculada.",
  COINOPS_VIEWER_BINDING_CHANGED:
    "O vínculo mudou durante a operação. Atualize a lista e confira a conta antes de tentar novamente.",
  COINOPS_VIEWER_RESTORE_IDENTITY_DENIED:
    "Não foi possível comprovar que esta identidade é o acesso de visualização original. Nenhum usuário Auth foi alterado.",
  COINOPS_VIEWER_RESTORE_ROLLBACK_FAILED:
    "A recuperação não foi concluída e exige conferir o estado do vínculo. Não crie outro usuário nem repita o envio sem verificar.",
};

function AccessDialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    titleId = useId();
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current?.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="px-access-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.stopPropagation();
        onClose();
      }}
      onClose={(event) => {
        if (!event.currentTarget.open) onClose();
      }}
    >
      <header>
        <h3 id={titleId}>{title}</h3>
        <button
          type="button"
          className="px-button"
          aria-label="Fechar gerenciamento"
          onClick={onClose}
        >
          Fechar
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function ViewerUsersPanel() {
  const requestId = useRef<string | null>(null);
  const [users, setUsers] = useState<Viewer[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const refresh = async () => {
    const response = await fetch("/api/coinops-viewers", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Acessos indisponíveis");
    const body = await response.json();
    setUsers(body.users ?? []);
    setAccounts(body.accounts ?? []);
    setLoaded(true);
  };
  useEffect(() => {
    void refresh().catch(() =>
      setMessage("Não foi possível carregar os acessos."),
    );
  }, []);
  const perform = async (operation: string, extra: Record<string, string>) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/coinops-viewers", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-coinops-admin-intent": "viewer-access",
        },
        body: JSON.stringify({
          operation,
          requestId:
            operation === "CREATE_WITH_PASSWORD"
              ? (requestId.current ??= crypto.randomUUID())
              : crypto.randomUUID(),
          ...extra,
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          viewerErrorMessage[body.error] ?? body.error ?? "Ação não concluída",
        );
      setMessage(
        operation === "CREATE_WITH_PASSWORD"
          ? "Cadastro criado. O cliente entra com o e-mail e a senha definidos, sem troca obrigatória. Após entrar, o cliente verá os primeiros passos; o vínculo da conta será feito depois."
          : operation === "CREATE"
            ? body.reusedAccess
              ? `Acesso recriado com a identidade original. Recuperação enviada para ${body.recipient}; use o e-mail mais recente. Nenhuma conta Binance ou motor foi recriado.`
              : "Convite enviado. O acesso é somente leitura e restrito à conta selecionada."
            : operation === "RESET"
              ? `Recuperação solicitada para ${body.recipient}. Confira a caixa de entrada e spam; use somente o e-mail mais recente. Isso não confirma recebimento na caixa postal.`
              : operation === "DELETE"
                ? "Acesso excluído da lista e mantido bloqueado. Auth, contas Binance, motores e histórico foram preservados."
                : operation === "ASSIGN"
                  ? "Conta vinculada. Nenhum motor, capital ou operação foi ativado."
                  : operation === "REASSIGN"
                    ? "Conta vinculada corrigida. O acesso continua desativado; confira a conta antes de reativar e enviar um novo link."
                    : operation === "ENABLE"
                      ? "Acesso reativado."
                      : "Acesso bloqueado imediatamente no CoinOps.",
      );
      await refresh();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Ação não concluída");
    } finally {
      setBusy(false);
    }
    return false;
  };
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void perform("CREATE_WITH_PASSWORD", {
      password: String(data.get("password") ?? ""),
      companyName: String(data.get("companyName") ?? ""),
      ownerName: String(data.get("ownerName") ?? ""),
      whatsapp: String(data.get("whatsapp") ?? ""),
      email: String(data.get("email") ?? ""),
    }).then((created) => {
      if (created) {
        form.reset();
        requestId.current = null;
      }
    });
  };
  const filtered = users.filter((user) =>
    [user.company_name, user.display_name, user.email, user.owner_name].some(
      (value) =>
        value
          ?.toLocaleLowerCase("pt-BR")
          .includes(search.trim().toLocaleLowerCase("pt-BR")),
    ),
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, totalPages);
  const displayed = showAll
    ? filtered.slice((currentPage - 1) * 10, currentPage * 10)
    : filtered.slice(0, 6);
  const selected = users.find((user) => user.user_id === selectedUserId);
  const metrics = [
    ["Cadastros", users.length],
    ["Acessos ativos", users.filter((user) => user.status === "ACTIVE").length],
    [
      "Acessos bloqueados",
      users.filter((user) => user.status !== "ACTIVE").length,
    ],
    [
      "Aguardando vínculo",
      users.filter((user) => !user.exchange_account_id).length,
    ],
  ] as const;
  return (
    <section
      className="px-onboarding px-access-admin"
      aria-label="Usuários e acessos"
    >
      <header className="px-access-heading">
        <div>
          <small>ADMINISTRAÇÃO</small>
          <h2>Clientes e acessos</h2>
          <p>Acessos de consulta vinculados às contas deste operador.</p>
        </div>
        <button
          type="button"
          className="px-button"
          aria-haspopup="dialog"
          onClick={() => setCreateOpen(true)}
        >
          Novo cliente
        </button>
      </header>
      <div className="px-access-metrics" aria-label="Indicadores de acessos">
        {metrics.map(([label, value]) => (
          <article key={label}>
            <span>{label}</span>
            <strong>{loaded ? value : "—"}</strong>
          </article>
        ))}
      </div>
      <div className="px-access-heading">
        <h3>{showAll ? "Todos os acessos" : "Cadastros recentes"}</h3>
        <button
          type="button"
          className="px-button"
          onClick={() => {
            setShowAll(!showAll);
            setPage(1);
          }}
        >
          {showAll ? "Ver recentes" : "Ver todos"}
        </button>
      </div>
      <label className="px-access-search">
        Buscar cliente
        <input
          type="search"
          value={search}
          placeholder="Empresa, responsável ou e-mail"
          onChange={(event) => {
            setSearch(event.target.value);
            setShowAll(true);
            setPage(1);
          }}
        />
      </label>
      <div className="px-access-list">
        {displayed.map((user) => (
          <article key={user.user_id} className="px-access-card">
            <div>
              <strong>{user.company_name || user.display_name}</strong>
              <small>
                {user.owner_name || user.display_name} · {user.email}
              </small>
              <small>
                {user.exchange_account_id
                  ? (accounts.find(
                      (account) => account.id === user.exchange_account_id,
                    )?.display_name ?? "Conta indisponível")
                  : "Aguardando vínculo"}
              </small>
            </div>
            <span
              className={
                user.status === "ACTIVE"
                  ? "px-access-active"
                  : "px-access-inactive"
              }
            >
              {user.status === "ACTIVE" ? "Ativo" : "Bloqueado"}
            </span>
            <button
              className="px-button"
              type="button"
              aria-haspopup="dialog"
              aria-label={`Gerenciar ${user.company_name || user.display_name}`}
              onClick={() => setSelectedUserId(user.user_id)}
            >
              Gerenciar
            </button>
          </article>
        ))}
      </div>
      {!displayed.length ? (
        <p>{loaded ? "Nenhum acesso encontrado." : "Carregando acessos…"}</p>
      ) : null}
      {showAll ? (
        <nav className="px-access-pagination" aria-label="Páginas de acessos">
          <button
            type="button"
            className="px-button"
            disabled={currentPage === 1}
            onClick={() => setPage(currentPage - 1)}
          >
            Anterior
          </button>
          <span>
            Página {currentPage} de {totalPages}
          </span>
          <button
            type="button"
            className="px-button"
            disabled={currentPage === totalPages}
            onClick={() => setPage(currentPage + 1)}
          >
            Próxima
          </button>
        </nav>
      ) : null}
      <AccessDialog
        open={createOpen}
        title="Novo cliente"
        onClose={() => setCreateOpen(false)}
      >
        <p>
          O cliente entra com o acesso de consulta. A conta Binance pode ser
          vinculada depois.
        </p>
        <form className="px-onboarding-form" onSubmit={create}>
          <label>
            E-mail
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Senha inicial
            <input
              name="password"
              type="password"
              minLength={8}
              required
              autoComplete="new-password"
              placeholder="Mínimo 8 caracteres"
            />
          </label>
          <label>
            Nome da empresa
            <input
              name="companyName"
              minLength={2}
              maxLength={120}
              required
              autoComplete="organization"
            />
          </label>
          <label>
            Nome do dono
            <input
              name="ownerName"
              minLength={2}
              maxLength={120}
              required
              autoComplete="name"
            />
          </label>
          <label>
            WhatsApp
            <input
              name="whatsapp"
              type="tel"
              required
              autoComplete="tel"
              placeholder="DDD e número"
            />
          </label>
          <button className="px-button" type="submit" disabled={busy}>
            Criar cadastro
          </button>
        </form>
        {message ? <p role="status">{message}</p> : null}
      </AccessDialog>
      <AccessDialog
        open={Boolean(selected)}
        title={
          selected?.company_name || selected?.display_name || "Gerenciar acesso"
        }
        onClose={() => setSelectedUserId(null)}
      >
        {selected
          ? (() => {
              const user = selected;
              const account = accounts.find(
                (row) => row.id === user.exchange_account_id,
              );
              return (
                <>
                  <p>
                    {user.owner_name || user.display_name} · {user.email}
                  </p>
                  <p>Conta: {account?.display_name ?? "Aguardando vínculo"}</p>
                  {account ? (
                    <nav className="px-access-destinations">
                      <Link
                        className="px-button"
                        href={`/automacao?view=live&account=${encodeURIComponent(account.id)}`}
                      >
                        Consultar conta
                      </Link>
                      <Link
                        className="px-button"
                        href={`/relatorios?account=${encodeURIComponent(account.id)}&environment=REAL`}
                      >
                        Relatórios da conta
                      </Link>
                    </nav>
                  ) : null}
                  <div className="px-account-actions">
                    <button
                      type="button"
                      className="px-button"
                      disabled={busy || user.status !== "ACTIVE"}
                      onClick={() =>
                        void perform("RESET", { userId: user.user_id })
                      }
                    >
                      Redefinir senha
                    </button>
                    {user.status === "ACTIVE" ? (
                      <>
                        <button
                          type="button"
                          className="px-button"
                          disabled={busy}
                          onClick={() =>
                            void perform("DISABLE", { userId: user.user_id })
                          }
                        >
                          Desativar
                        </button>
                        <button
                          type="button"
                          className="px-button"
                          disabled={busy}
                          onClick={() =>
                            void perform("REVOKE", { userId: user.user_id })
                          }
                        >
                          Revogar acesso
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="px-button"
                          disabled={busy}
                          onClick={() =>
                            void perform("ENABLE", { userId: user.user_id })
                          }
                        >
                          Reativar
                        </button>
                        <button
                          type="button"
                          className="px-button"
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Excluir o acesso de ${user.email}? Ele ficará bloqueado e sairá da lista. O e-mail e a identidade Auth serão preservados. Nenhuma conta Binance, motor ou histórico será excluído.`,
                              )
                            )
                              void perform("DELETE", { userId: user.user_id });
                          }}
                        >
                          Excluir acesso
                        </button>
                      </>
                    )}
                  </div>
                  {user.status === "ACTIVE" && !user.exchange_account_id ? (
                    <form
                      className="px-onboarding-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        void perform("ASSIGN", {
                          userId: user.user_id,
                          accountId: String(data.get("accountId") ?? ""),
                        });
                      }}
                    >
                      <label>
                        Vincular conta depois do cadastro
                        <select name="accountId" required defaultValue="">
                          <option value="" disabled>
                            Selecione uma conta
                          </option>
                          {accounts.map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.display_name} · {account.status}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="submit"
                        className="px-button"
                        disabled={busy || !accounts.length}
                      >
                        Vincular conta
                      </button>
                    </form>
                  ) : null}
                  {user.status !== "ACTIVE" ? (
                    <>
                      <small>
                        Acesso bloqueado. Não utilize convites antigos desta
                        conta.
                      </small>
                      <form
                        className="px-onboarding-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const data = new FormData(event.currentTarget);
                          void perform("REASSIGN", {
                            userId: user.user_id,
                            accountId: String(data.get("accountId") ?? ""),
                          });
                        }}
                      >
                        <label>
                          Corrigir conta de {user.email}
                          <select
                            key={user.exchange_account_id}
                            name="accountId"
                            required
                            defaultValue={user.exchange_account_id ?? ""}
                          >
                            {accounts.map((account) => (
                              <option value={account.id} key={account.id}>
                                {account.display_name} · {account.status}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="submit"
                          className="px-button"
                          disabled={busy}
                        >
                          Corrigir vínculo · manter desativado
                        </button>
                      </form>
                    </>
                  ) : null}
                </>
              );
            })()
          : null}
        {message ? <p role="status">{message}</p> : null}
      </AccessDialog>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
