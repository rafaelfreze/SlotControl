# CoinOps — capacidade e shards (base de decisão)

Estado em 26/09/2026: quatro contas e sete motores LIVE no executor 01. Esta
entrega é **modelo de capacidade**, não escala de 50 contas aprovada nem gate
ativo de ativação. Não cria VPS, IP, ordem ou migration.

## Medição e thresholds iniciais

O IP compartilha limite Spot observado de 6.000 REQUEST_WEIGHT/min. Em duas
amostras durante auditoria, média 3.614 e pico 3.628 (~60,5% do limite);
minutos mais tranquilos foram 2.668 e 2.258. A auditoria pode ter aumentado
as leituras. CPU ~4,9% de um núcleo e executor ~147 MB no VPS de 961 MB.
Portanto, o primeiro gargalo observado é o orçamento Binance/IP.

| Uso do limite Binance | Estado | Ação |
| --- | --- | --- |
| <50% | HEALTHY | Observar normalmente |
| 50–65% | OBSERVE | Medir média móvel/pico e custo incremental |
| 65–75% | WARNING | Planejar shard/IP antes de saturar; alerta admin |
| ≥75% | CAPACITY_LIMIT | Não admitir nova carga no shard |

Uma nova atribuição só pode passar se telemetria e heartbeat tiverem até 120 s,
custo incremental p95 tiver sido **medido**, o shard não estiver WARNING/OFFLINE
e a projeção permanecer ≤65%. A faixa de 65–75% fica reservada para
reconciliação/recovery e variação. Em 3.628/min, existem 872 unidades/min
até o limite de 75%, mas **não há custo incremental confiável da próxima
conta**; a resposta técnica atual é `CAPACITY_REQUIRED`, não SIM.
Thresholds são configuráveis; recalibrar com p95 de janela longa, não com
essas amostras curtas.

CPU ≥70% ou RAM ≥75% avisa; CPU/RAM ≥85% sustentados impedem admissão e
indicam SCALE_UP se o peso Binance estiver folgado. Peso ≥65% indica
SCALE_OUT para novo shard/IP. Backlog ≥1 ou reconciliação p95 ≥45 s exigem
investigação da causa antes de atribuir ação. Heartbeat ou telemetria
stale → OFFLINE/fail-closed. Falhas/retries são medidos no modelo, mas
threshold automático depende de baseline operacional adicional.

## Invariantes

Conta → credencial → engine → job → lease → ledger/reconciliation → alerta →
kill switch permanecem no mesmo escopo. Um engine BLOCKED não bloqueia seus
irmãos. Kill switch global somente por causa sistêmica comprovada. Cada
conta possui um único shard primário de IP fixo; não existe rotação para
contornar Binance. Novo executor passa por registro, health e whitelist antes
de receber **novas** contas. Conta LIVE não migra automaticamente.

O módulo `capacity-manager.ts` calcula estado, recomendação SCALE_UP/OUT,
alert codes e decisão de admissão em funções puras. Não lê credenciais nem
modifica trading. Códigos preparados: `EXECUTOR_CAPACITY_WARNING`,
`BINANCE_WEIGHT_WARNING`, `SCHEDULER_BACKLOG_WARNING` e
`EXECUTOR_RESOURCE_WARNING`.

## Lacuna antes de enforcement

Ainda faltam telemetria server-side por shard (peso com cabeçalho Binance,
média/pico, CPU/RAM, backlog, p95 e heartbeat), persistência/registro da
atribuição única, integração transacional no POST de ativação, card ADMIN e
entrega de alertas/push. **Não** usar amostras manuais ou valores estáticos
como autorização para nova conta. A implantação desses componentes deve
preservar os sete LIVE e testar falha de 1 engine, 5 engines e uma credencial.
