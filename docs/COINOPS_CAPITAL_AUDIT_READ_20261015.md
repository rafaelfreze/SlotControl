# Observação de auditoria do refresh de capital — 15/10/2026

## Incidente observado

O cron LIVE de 15/10/2026, iniciado 14:22:04Z, registrou às 14:23:01.131Z
`COINOPS_LIVE_CAPITAL_AUDIT_UNAVAILABLE` em dez motores, com cinco OK e um PAUSED.
Os ciclos seguintes às 14:25:35 e 14:26:38Z retornaram quinze OK e um PAUSED.
OK de reconciliação não prova que um gate/alerta anterior tenha sido resolvido.

O GET de eventos NEXT_BUY_CAPITAL_REFRESH_* fazia uma única leitura não paginada,
sem orçamento próprio/timeout, descartando o erro original do provider. Executava
depois de armar/verificar a entrada, mas herdava o stage ARM_ENTRY ou
ASSERT_NEW_POSITION. Não é possível reconstruir o HTTP original desse episódio:
não afirmar 503, rejeição Binance, alteração de saldo ou perda de gain sem prova.

## Correção mínima

Reader `readCapitalRefreshEvents`: todos os identificadores de escopo, quote,
run e engine, índice scoped já existente, ordenação estável observed_at/id,
páginas de 500 e verificação de identidade/duplicidades/completude. Mesma política
GET-only canônica: duas fotografias completas, até 5s cada, separadas por 250ms;
uma página transitória descarta o conjunto parcial. Erro HTTP/código sanitizado
é preservado; 400, permissão, schema e dado inválido não se tornam transitórios.

Stage próprio CONFIRM_CAPITAL_REFRESH; confirmação `event()` permanece fora do
retry. Não repetir cancel/create, crédito, decisão, dispatch ou evento financeiro
por causa de falha de leitura. Ownership do ledger continua autoridade do
checkpoint de cancelamento, não a presença do evento de auditoria.

## Recuperação normal e legada

- Legado: código e root COINOPS_LIVE_CAPITAL_AUDIT_UNAVAILABLE, somente stage
  ARM_ENTRY/ASSERT_NEW_POSITION. Isso identifica o GET antigo, não sua causa HTTP.
- Novo: LEDGER_READ_STALE, root LEDGER_READ_UNAVAILABLE, stage
  CONFIRM_CAPITAL_REFRESH, path ledger/capital_refresh_events exatos.
- Normal cron só retoma após lease, health/ownership, 25 slots, caps, posições,
  TPs e NEXT BUY provados, decisões/dispatches assentados duas vezes, releitura
  completa da auditoria, incidente único inalterado e CAS pelos mecanismos atuais.
- A releitura na retomada é GET-only: não escreve CONFIRMED nem aprova mudança
  de capital. Um PLANNED pendente legítimo durante fill/cancel não é erro por si.
- Estado financeiro ambíguo, permissão/schema, incidente trocado ou prova
  incompleta continuam fail-closed somente no engine afetado.

Sem migration, alteração de estratégia, ordem artificial, runtime VPS ou restart.
Regressões: live-capital-read-server, live-read-recovery e
live-read-recovery-server; suíte de ledger/capital refresh/recovery relacionada.
Revisão independente: 63/63 testes do escopo aprovados antes da publicação.
