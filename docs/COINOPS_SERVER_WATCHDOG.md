# CoinOps — watchdog server-side

O navegador, o PC e o Codex não participam do laço operacional. A Vercel executa
`/api/cron/live-execution` a cada minuto; esse worker é a autoridade para
reconciliar Binance ↔ ledger e, quando provado seguro, proteger TP, armar a
próxima BUY e recuperar um ciclo. Seu lease é por `robot_v1_live_runs.id`.
`/api/cron/coinops-capacity` também roda a cada minuto, descobre shards pela
tabela `executor_shards`, lê heartbeat/CPU/RAM/weight/fila e alerta sobre shard
offline ou saturação. O `systemd` em cada VPS reinicia o processo executor.

A supervisão Codex de Production a cada duas horas é uma camada separada:
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
