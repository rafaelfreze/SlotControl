# Recuperação de auditoria e horário de ingestão — 31/10/2026

CoinOps / OnPlay Platform `otdfpmsegjxpqrzisfmi` / schema `coinops` / REAL.

Após corrigir a consulta de capital, surgiram falhas secundárias de observação.
Slots/Watchdog convergiram pelo fluxo oficial, mas Thyely/BTCBRL, engine
`785ae434-9a8a-4a1d-9418-1d43bd8fa11a`, run
`c9953b67-4482-46bd-8227-96d849e4043f`, Executor01, ficou bloqueado em
`COINOPS_LIVE_EVENT_PERSIST_FAILED` / AUDIT_EVENT / READBACK_UNAVAILABLE.
Não atribuir um HTTP específico: a evidência capturada contém status/provider null.

O evento original `RECONCILED:2026-10-31T11:35` existe desde 11:35:26.890888Z.
O alerta registra observação do caller em 11:35:44.905Z (`last_seen_at`) e
ingestão no banco em 11:35:47.551021Z (`first_seen_at`). A diferença de 2,646s
é comprovada. Reconciliações posteriores KILL_SWITCH existem às 11:37, 11:38
e 11:39, mas o guard rejeitava permanentemente `first-last > 1s` antes de
examinar essa prova. Não há prova de perda de ordem, saldo ou posição.

`first_seen_at` e `last_seen_at` têm origens distintas; não são relógios
ordenáveis entre si por uma tolerância arbitrária de 1s. A correção remove
somente essa comparação, mantendo `max(first,last) < observed` e todos os
limites de frescor e ordem de event/reconciled/now. Prova entre os dois horários,
futura, ausente, obsoleta, estrangeira ou inválida continua rejeitada.

Nenhum horário histórico é normalizado ou reescrito. A identidade original
de ambos continua no readback e no CAS final. Permanecem lease, reconciliação
financeira integral, TPs/ownership, decisões/dispatches assentados duas vezes,
caps, meta e gates de configuração. Nenhum evento histórico é reemitido.

Regressões unitária e do resume real reproduzem os horários do incidente,
as duas ordens de ingestão/observação, prova anterior/futura, TP ausente,
dispatch pendente e alteração de timestamp sob CAS. Somente fixtures locais.

Esta segunda publicação é necessária por uma falha residual real descoberta
na validação do incidente de índice. Não requer migration, restart nativo,
alteração de configuração nem intervenção manual nos gates.
