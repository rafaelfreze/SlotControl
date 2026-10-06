# CoinOps — watchdog server-side

Política de observação, distinção RECONCILING/RECOVERING, registry de recorrência
e SLO v18: `COINOPS_TRADING_RELIABILITY_20261005.md`. Watchdog é fallback, nunca
uma etapa obrigatória de gain/fill. Não contar recovery do cron normal como ação
do Watchdog.

O navegador, o PC e o Codex não participam do laço operacional. A Vercel executa
`/api/cron/live-execution` a cada minuto; esse worker é a autoridade para
reconciliar Binance ↔ ledger e, quando provado seguro, proteger TP, armar a
próxima BUY e recuperar um ciclo. Seu lease é por `robot_v1_live_runs.id`.
`/api/cron/coinops-capacity` também roda a cada minuto, descobre shards pela
tabela `executor_shards`, lê heartbeat/CPU/RAM/weight/fila e alerta sobre shard
offline ou saturação. O `systemd` em cada VPS reinicia o processo executor.

A auditoria Codex diária de Production é uma camada separada:
consulte `COINOPS_PRODUCTION_MONITOR_2H.md`. Seu fast path é somente leitura,
usa registry/telemetria/ledger e não executa chaos tests ou Testnet por rotina.
Incidentes novos só ampliam auto-recovery após causa determinística,
reconciliação, idempotência, isolamento e regression test comprovados.

`/api/cron/coinops-watchdog` é a segunda camada server-side, a cada minuto.
O caminho normal consulta somente Supabase: registry de shards, última
telemetria, runs ACTIVE, vínculo conta→shard, engine, 25 slots, ordens residentes
e incidentes abertos. Não chama Binance REST em um ciclo saudável. Avalia
identidade, lease, reconciliação recente, erro, bloqueio local, slot count,
BUY duplicada e TP residente no ledger. O teste barato não substitui a verdade
da Binance: o reconciliador LIVE confirma estado de ordens e estratégia.

Se um run estiver sem reconciliação há mais de 5 minutos ou com TP residente
ausente no ledger e o shard tiver heartbeat, o watchdog pode chamar
`advanceLiveRun` pelo mesmo lease/idempotência já usados pelo cron normal.
O incidente só permite uma tentativa a cada 5 minutos. Duas execuções
simultâneas não podem reivindicar o mesmo incidente nem o mesmo run.
Erros desconhecidos, ownership divergente, TP/BUY duplicada e kill switch
ficam `BLOCKED_SAFE`; não há MARKET direta, cancelamento de ordem saudável,
troca de shard/IP nem limpeza de kill switch pelo watchdog. O incidente só
é resolvido após uma reconciliação bem-sucedida refletida no ledger.

## TP preenchido e continuação do ciclo

`SLOT_PROFIT_CREDITED` é um evento operacional normal, não um incidente. O
worker LIVE continua o mesmo fluxo oficial até um estado estável: crédito
idempotente do gain, reciclagem local ou criação atômica do run sucessor,
MARKET inicial quando a Strategy Engine determinar, TP protetor e uma única
NEXT BUY. O coordenador apenas segue `nextRunId` e `INITIAL_SUBMITTED`; ele não
replica decisões da Strategy Engine nem autoriza ordens por conta própria.

O reset global permanece recuperável por checkpoints persistidos. A RPC usa
um único sucessor por `previous_run_id`, `reset_idempotency_key` estável e lock;
ordens usam `clientOrderId`, decisão e submission guard determinísticos. Se a
invocação cair depois do crédito, criação do sucessor, MARKET ou TP, a próxima
execução retoma o run persistido e reconcilia Binance antes de qualquer novo
write. Resultado financeiro ambíguo continua fail-closed no engine afetado.

O sucessor é avançado pelo cron que concluiu o ciclo, com lease próprio. Enquanto
esse lease está ativo o watchdog exibe `RECONCILING` sem código/alerta. Se o cron
cair antes de reivindicá-lo, o watchdog chama o mesmo `advanceLiveRun`; nunca
uma segunda implementação. Falha breve 502/503 mantém apenas o alerta WARNING
transitório e não grava `last_error`; persistência superior à janela segura
promove a falha real e bloqueia somente o engine.

Os registros ficam em `coinops.watchdog_checks` (última checagem por shard) e
`coinops.watchdog_incidents` (um registro por episódio, índice único parcial
para incidente aberto). Alertas críticos por engine usam
`robot_v1_live_alerts` e o push administrativo já deduplicado. Alertas de
shard OFFLINE/capacidade continuam no pipeline `executor_capacity_alerts`.
O card Watchdog só é consultado por ADMIN autenticado; VIEWER não o recebe.

Falhas conhecidas de leitura, inclusive `COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY`,
podem ser retomadas pelo cron LIVE após reconciliação OK, nunca por um write
direto do watchdog. A retomada exige lease, único alerta crítico allowlisted
inalterado, health verificado, TP protegido, Binance/ledger/clientOrderId coerentes,
parent gates e limites. O alerta é resolvido por compare-and-set; causa trocada
falha fechada. O cron registra VERIFIED_READ_RECOVERY no incidente e o watchdog
seguinte confirma HEALTHY independentemente. Alertas críticos de outros motores
ou ciclos não autorizam nem bloqueiam essa recuperação.

A API do card considera críticos pendentes além da amostra dos shards; uma
amostra HEALTHY anterior não vence um incidente conhecido. Checagem por minuto
não significa detecção instantânea. Aba reaberta atualiza a leitura e telemetria
expirada não continua exibida como saudável. Evidência real e limitações do
incidente Diogo: `COINOPS_WATCHDOG_DIOGO_20260927.md`.

## Limites e escalonamento

- TP `NEW` no ledger não prova, isoladamente, proteção na Binance. A validação
  vem da reconciliação LIVE; nenhuma recuperação deve ser feita diretamente
  a partir do snapshot barato.
- Um erro de escrita com resultado incerto permanece bloqueado até a consulta
  Binance e o reconciliador provarem o resultado. O watchdog não adivinha.
- `systemd Restart=always` cobre queda do processo executor; queda do VPS,
  credencial inválida e falha sistêmica externa exigem alerta/intervenção.
- A auditoria profunda `/api/cron/live-monitor` permanece a cada seis horas
  para não multiplicar o peso Binance. Não aumentar frequência sem medição.
- Incidentes resolvidos após tentativa do watchdog não provam entrega física
  de Web Push; consultar a tabela de deliveries para essa evidência.

## Publicação e rollback

Confirmar project ref `otdfpmsegjxpqrzisfmi`, schema `coinops`, tenant de
serviço e branch/main. Aplicar a migration aditiva
`20260926233241_add_coinops_server_watchdog.sql` antes do deploy Vercel.
Depois de READY, confirmar cron autenticado, `watchdog_checks` fresco para
todos os shards, incidentes/deliveries e os nove engines LIVE sem mudança de
ordens, kill switches ou estratégia. Para rollback, retornar a Vercel ao SHA
anterior (removendo o cron); manter as duas tabelas como trilha histórica.
Nunca fazer DROP de incidente ou reverter ordens por causa do watchdog.
# TP PREPARED após timeout na ativação (COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN)

Se a ativação REAL expirar, o primeiro processamento financeiro ocorre no cron,
com prazo próprio. O reconciliador mantém o motor isolado enquanto não houver
prova de resultado. Para um TP protegido por `submission_guarded_at` sem ordem
na Binance, recuperação automática só é permitida com o **mesmo**
`clientOrderId`, lease exclusivo, guard antigo (ao menos 3 minutos) e decisão
`CREATE_TP` do mesmo ciclo/slot/operação ainda `PENDING`, sem
`dispatched_at`, ACK ou conclusão. Isso prova que o fluxo oficial não chegou
ao executor: o marcador de despacho é persistido antes de qualquer pedido
`/v1/create-order`. O executor consulta a Binance primeiro e mantém seu claim
durável contra segundo POST incerto. BUY guardado, decisão já despachada,
evidência ausente, identidade divergente ou leitura falha continuam
`BLOCKED_SAFE`; nunca liberar apenas porque GET retornou vazio.

Após o TP aparecer no executor e no ledger, validar posição coberta, preço,
reconciliation e alertas. O resume server-side só abre o BUY gate depois da
checagem completa; o Watchdog confirma e encerra o incidente separadamente.
Regressões: `live-unsent-tp-recovery.test.ts`,
`live-entry-capital-refresh-flow.test.ts`, `live-read-recovery.test.ts`.
