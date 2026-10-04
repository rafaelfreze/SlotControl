# Coleta account-global — recuperação de janela e lock

## Incidente de 04/10/2026

Dete tentou preparar BTCBRL no Executor 02. O preview passou às 18:57:56 UTC;
uma coleta às 18:58:20.445 UTC recebeu `EXECUTOR_ACCOUNT_ORDER_BUDGET_UNKNOWN`
(503, 2410ms), compatível com a travessia da janela ORDERS de 10s. O executor
rejeita deliberadamente amostra cujo contador atravessou uma janela.

O control plane só liberava o probe ao gravar uma amostra válida. Falha deixava
o lease de 45s ocupado; a confirmação seguinte recebeu
`COINOPS_ACCOUNT_ORDER_BUDGET_PROBE_BUSY`. Às 19:00:30 UTC, o lease já tinha
expirado em 18:59:02.910596 UTC. Não era falta de espaço nem duplicidade de
motor: leitura mostrou somente o SOLBRL original ACTIVE no 02. A política
ENGINE_ISOLATION_V2 foi habilitada pelo fluxo confirmado do proprietário;
nenhum BTCBRL foi criado.

## Correção mínima, somente web

- Falha sempre encerra apenas seu probe, por compare-and-set de operador,
  conta e lease_owner. Não altera lease de run, ordem, permit ou reserva.
- Sucesso continua usando o RPC existente, que grava e libera atomicamente.
- Falha de banco não é traduzida falsamente como concorrência.
- Rejeição 503 exata `EXECUTOR_ACCOUNT_ORDER_BUDGET_UNKNOWN` pode repetir
  somente a coleta administrativa read-only após 5,5s, respeitando o cooldown
  de 5s do executor. No máximo três tentativas e orçamento total de 35s.
- Lease de outro worker não é roubado: espera limitada e nova aquisição
  normal. Sem disponibilidade, permanece bloqueado e a UI explica a consulta
  concorrente sem perder formulário/request_id.
- Scope inválido, autenticação, rate limit, erro de rede e erro de persistência
  não são tratados como a rejeição recuperável. Não aceitar evidência expirada,
  alterar limites, prolongar sample, forçar admission ou repetir ordem Binance.

Testes executam o collector real com DB/transport sintéticos: falha de janela
→ liberação → cooldown → amostra válida; nova coleta após sucesso;
network/scope/banco; contenção; fencing contra sucessor; limite de tentativas
e deadline. Regressões de orçamento/ownership/idempotência permanecem.

Nenhuma migration ou mudança de runtime do VPS é necessária. Grants privados
existentes já permitem UPDATE restrito do probe ao service_role; RLS/anon/viewer
não mudam. Manifest/runtime comum permanece ad59af3; não reiniciar executores.
Smoke Production deve usar apenas preview, sem confirmar/criar/ativar motor.

Validação local: 22 testes direcionados PASS (collector, observação, orçamento,
permits, ownership e criação idempotente); lint direcionado, typecheck e build
PASS. Harness sintético de append em desktop/mobile: 2 testes PASS, sem requests
externas nem criação real. Fingerprint do runtime do executor inalterado
(`fleet-parity.mjs --check-code` PASS).

## Segunda falha — confirmação, 15:24 local (19:24 UTC)

O preview público aprovado não comprovou a confirmação. Nesta tentativa, a
leitura administrativa foi 200 às 19:24:14.335 UTC (1960ms); a confirmação
retornou UNKNOWN. O código ainda fazia preview RPC + gravação de allocation
antes do gate SQL final: a amostra ORDERS de 10s podia vencer no trajeto ou ao
aguardar lock. Nova leitura às 19:24:29.576 e preview às 19:24:24.796 foram
persistidos, mas não havia BTCBRL nem check ENGINE_APPEND. Portanto não houve
criação parcial para repetir. A expiração é a hipótese causal consistente
com o código e os tempos; os logs antigos não preservam o motivo SQL detalhado.

A confirmação agora recolhe uma amostra assinada POR ÚLTIMO, imediatamente
antes do RPC serializado. Exige pelo menos 4s restantes da janela original,
inclusive depois de gravar a amostra (margem para RTT/lock, não extensão da
validade). Amostra perto do fim é descartada e recolhida após 5,5s; o contador
nunca é zerado localmente. Ownership completo é validado antes de classificar
expiração como recuperável. Limites, SQL, reservas de proteção e freshness
de 30s permanecem inalterados.

Se o próprio gate SQL perder a janela, apenas P0001 explícito com mensagem
exata COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN permite UM retry do RPC, com mesmo
request_id e revalidação integral de wallet/hash/capacidade/budget. Esse RAISE
está antes das inserções e garante rollback. Timeout, rede, resposta ambígua,
outro código ou UNKNOWN persistente não são repetidos nem viram PASS. O prazo
do fluxo é 50s, dentro dos 60s da rota; collectors continuam limitados a 35s,
três leituras, usando o prazo restante do fluxo.

26 regressões PASS: inclui validade após latência de persistência, amostra
expirada no transporte, confirmação com rollback/UUID único, UNKNOWN
persistente e timeout sem retry SQL. Lint direcionado, typecheck e build PASS.
Publicação somente web, sem migration,
alteração de credenciais, estratégias ou restart de VPS. Preparação INACTIVE
e ativação REAL são etapas distintas: ativação pelo navegador exige handoff
ao proprietário; não usar trade como smoke.
