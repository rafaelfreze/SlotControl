# Incidente REAL Diogo / SOLBRL — watchdog

## Escopo e evidência anterior à correção

- Ambiente REAL, Executor 02 (`164.90.223.159`). Não houve falha artificial,
  clique em Retomar, alteração SQL de gate, cancelamento ou submissão manual de ordem.
- Motor `6c2f2556-611e-4895-aeaf-20367113816b`, ciclo
  `61ded6c9-8202-4bff-bfd6-336ac4309a04`.
- Horários abaixo em UTC; subtrair quatro horas para o horário local do operador.
- `00:00:08.644` em 2026-09-27: `/v1/health` retornou ATTENTION/503 após 6.472 ms.
  Retentativas às `00:00:09.365`, `10.583` e `12.294` também retornaram 503.
  Leituras READ_STATE/QUERY_ORDER intercaladas retornaram 200.
- `00:00:12.557534`: alerta CRITICAL `COINOPS_LIVE_MONITOR_EXECUTOR_UNHEALTHY`.
  O monitor fechou somente o gate de novas entradas desse motor.
- `00:00:46.445768`: watchdog abriu incidente
  `266d0f1d-04ec-4890-b26b-a492a1e5dca8`, condição
  `WATCHDOG_LOCAL_GATE_CLOSED`, estado BLOCKED. Detectou em aproximadamente 34 s.
- Até `00:17`: reconciliação normal a cada minuto, resultado OK/KILL_SWITCH;
  incidente OPEN, nenhuma tentativa automática de retomada. Não classificar esta
  fase como AUTO_RECOVERY_PASS.
- Snapshot direto às `00:15:10`: Binance e ledger concordam em TP SELL NEW
  `428985422` a 661,90, quantidade 0,017; ENTRY BUY NEW `428985666` a 610,80,
  quantidade 0,018. Não houve perda de proteção ou duplicação observada.
- Health direto às `00:15:09`: HEALTHY, SPOT_RESTRICTED, IP correto e verificado,
  conectividade OK, drift -0,5 ms. Executor permaneceu na versão
  `fd567fe613108c0c7e2ae7bed57cd02ed7ff7d30`; nenhum restart.
- Às `00:12:56`: os outros oito motores ACTIVE, gates abertos, última
  reconciliação entre `00:12:14` e `00:12:28`, sem last_error. Blast radius = 1.

## Causa e limites da evidência

COMPROVADO: o código exato emitido pelo monitor não estava na allowlist de
recuperação de falhas de leitura. A reconciliação continuava, mas nunca chamava
a retomada guardada para esse código. O watchdog apenas observava o gate fechado.

COMPROVADO: o endpoint do card e a policy não consideravam alertas críticos na
decisão HEALTHY; o card também aguardava seu polling de 60 s. O card observado
durante a investigação já mostrava ATTENTION, 8 saudáveis e 1 bloqueado.
Portanto o HEALTHY inicial pode ter sido a amostra anterior ao ciclo de detecção;
a exata duração da exibição inicial não foi capturada.

NÃO TESTADO: a causa externa precisa do primeiro health 503. O log antigo não
persistiu os campos de permissão/IP do payload malsucedido. Não atribuir o evento
definitivamente a rate limit, permissão Binance ou ipify por inferência. O código
cacheava o health por 20 s; latências de 7/3/3 ms são compatíveis com cache.

## Correção

- O código MONITOR_EXECUTOR_UNHEALTHY passa a ser elegível ao fluxo existente
  VERIFIED_READ_RECOVERY, somente após advanceLiveRun=OK.
- Sob lease exclusivo, exige o único alerta crítico conhecido do ciclo; repete
  a leitura do incidente depois das verificações externas. Health fresco,
  account/engine/shard, parent gates, Binance × ledger, clientOrderId, proteção,
  fills, unicidade de BUY e limites continuam obrigatórios.
- Resolução do alerta condicionada ao mesmo código e last_seen_at. Causa
  alterada/desconhecida falha fechada; nenhum novo caminho direto de ordens.
- Watchdog usa os alertas críticos explicitamente escopados e registra a causa.
  API do card não anuncia HEALTHY com crítico pendente. Telemetria antiga,
  inválida, futura ou shard ausente não comprova saúde.
- Card reconsulta ao voltar para a aba e marca amostra expirada. Frequência de
  Binance e estratégias permanecem inalteradas.

## Validação e acompanhamento

Preencher o resultado pós-publicação somente com eventos e snapshots reais.
Fixtures não comprovam entrega física de push, falha/recovery de executor,
reset, criação de TP ou NEXT BUY: esses cenários não ocorreram neste episódio.

Rollback: reverter somente o commit deste hotfix via Git/main; nunca restaurar
ledger/gates/ordens anteriores. O rollback remove a elegibilidade automática do
código, mas não remove as ordens protetoras existentes.
