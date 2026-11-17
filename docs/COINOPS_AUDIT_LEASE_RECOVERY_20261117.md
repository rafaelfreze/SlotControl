# Recuperação segura de lease na auditoria final — 17/11/2026

CoinOps REAL, projeto Supabase `otdfpmsegjxpqrzisfmi`, schema `coinops`.
Diogo/SOLBRL, Executor 02, engine `6c2f2556-611e-4895-aeaf-20367113816b`,
run `61ded6c9-8202-4bff-bfd6-336ac4309a04`. Às 06:19:29 UTC houve
`COINOPS_LIVE_LEASE_LOST`, etapa `AUDIT_EVENT`; Watchdog detectou o incidente
`5038dd3b-bbb8-4939-80b0-fb44be249c78` e bloqueou apenas esse engine.

O worker voltou a reconciliar normalmente, emitindo novos checkpoints com
`next=KILL_SWITCH`, mas o alerta não era elegível à retomada automática.
O código de renovação registra o mesmo erro tanto para perda da lease quanto
para falha da consulta; não havia diagnóstico suficiente para distinguir
expiração, concorrência ou erro de banco nessa tentativa histórica.
Não preencher o checkpoint histórico ausente com um estado posterior.

Em leitura autenticada às 12:11 UTC: 25 slots, 16 posições abertas com
16 TPs e uma NEXT BUY. Binance e ledger coincidiam em identidade, lado,
preço e quantidade; não havia claims nem dispatches sem ACK. O motor foi
mantido bloqueado enquanto as provas eram incorporadas ao fluxo oficial.

A elegibilidade nova é restrita ao código/root exatos LEASE_LOST em
AUDIT_EVENT, sem diagnóstico adicional que aponte outra causa. Esta etapa
também abrange o marco de reset de um ciclo sucessor: como o alerta legado
não identifica o evento, ciclos com predecessor permanecem fechados.
Exige run ACTIVE original, reconciliação posterior ao incidente, checkpoint
recente e íntegro do mesmo run, leitura atual de Binance, ledger completo,
TPs, limites, configuração e ausência de decisões financeiras inacabadas ou
dispatches sem ACK. Checkpoint e decisões são conferidos duas vezes sob nova
lease, com CAS do alerta inalterado. Divergência ou ambiguidade permanece
BLOCKED_SAFE no engine. Nada autoriza repetir ordem ou gravação histórica.

O cron normal usa `VERIFIED_READ_RECOVERY` e o Watchdog confirma o fechamento.
Fixtures cobrem predecessor, estágio/diagnóstico incorreto, evento ausente,
velho ou estrangeiro, falha de leitura, TPs, configuração, concorrência,
decisão/dispatch pendente, incidente alterado e isolamento de motores.
Não há migration nem alteração de runtime nativo ou parâmetros financeiros.
Consultar também `COINOPS_AUDIT_EVENT_RECOVERY_20261021.md`.

Validação local: 91 testes direcionados, typecheck, lint e build aprovados.
Os avisos preexistentes de CSS vendor e Supabase no Edge não impediram o build.
O manifesto financeiro web foi regenerado; não houve migration ou mudança nativa.
