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
