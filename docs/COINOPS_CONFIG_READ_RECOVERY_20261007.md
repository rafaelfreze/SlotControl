# CoinOps — observação de configuração e recuperação

## Causa comprovada

Rafael/BTCBRL, engine `516530f6-16dc-4617-be9b-ccb32d1d4e57`,
run `d49c8b87-b2c2-4965-830f-e3b5e293f282`, Executor 01,
incidente `5f1ab540-bcea-483d-b60f-62dc449b8507`:
`COINOPS_BULK_CHECKPOINT_UNAVAILABLE`, CONFIG_UPDATE, às
2026-10-07T21:02:17.878867Z (17:02:17 America/Campo_Grande).

O checkpoint era um GET sem retry/deadline/classificação compartilhados.
Qualquer provider error virava erro genérico, descartando HTTP/code, e
CONFIG_UPDATE o tratava como falha de edição. Não havia atualização bulk
para esse engine; gate `strategy_config_pending=false`. Reconciliações
seguintes completaram OK, mas a recuperação não reconhecia esse código.
Watchdog detectou BLOCKED, sem recovery concorrente.

Não está comprovado o erro original de transporte (timeout/503/Earn).
Logs Supabase da janela contêm PATCH de bloqueio sem linha elegível e GETs
200 dos demais engines; não contêm resposta de erro para o GET deste engine.
Não interpretar ausência de log como diagnóstico de rede conclusivo.

Às 21:54 UTC, `/v1/health` e `/v1/state` assinados, no IP 46.101.104.48,
confirmaram runtime 66543a8027b4af79ba2a1c4e85a69638b8b4e6db, health OK,
10 TPs e 1 NEXT BUY NEW, mesmos IDs/client IDs, quantidades e preços do
ledger, sem fill pendente. 25 slots/contas físicos; outros 15 engines HEALTHY.

## Correção estrutural delimitada

- Reutilizar `live-ledger-read.ts` para checkpoint bulk, gate de configuração,
  cap da moeda, preparação e operador. Não criar uma política particular por
  incidente. Somente GETs, 2 tentativas até 5s cada, intervalo 250ms.
- Happy path mantém a quantidade de consultas existente. Nenhum novo polling
  Binance, cron, RPC financeiro ou plataforma de observabilidade.
- Provider code/recurso/HTTP/tentativas sanitizados são preservados.
  Permissão/schema, configuração ausente/inválida e ownership divergente não
  recebem retry transitório nem valor padrão permissivo.
- Exaustão transitória usa o checkpoint durável já existente; a próxima
  execução normal reconcilia desde o início, usando as idempotências oficiais.
  Não marcar atualização real BLOCKED_SAFE por esse erro de observação.
- Janela existente de 5min não é prolongada; outage persistente bloqueia
  apenas o engine. TP/fills e ordens residentes não são cancelados pelo gate.
- Nunca repetir POST, UPDATE, RPC ou função financeira inteira pelo helper.
  Outras falhas de escrita/ownership permanecem fail-closed.

## Recuperação do legado

Sem SQL para limpar alertas/gates, sem repetir Ativar, reset ou recriar ordem.
O cron normal só solicita `resumeLiveRun(..., VERIFIED_READ_RECOVERY)` após
reconciliação OK de run ACTIVE. Exige:

1. Mesmo único CRITICAL, código/root exatos e stage CONFIG_UPDATE;
   alert key/timestamps inalterados, lease e ownership fresco engine/shard.
2. Gate de configuração boolean false e **zero** PENDING/APPLYING/BLOCKED_SAFE
   em qualquer run do mesmo engine, incluindo edição futura. Ler antes e
   depois da confirmação externa. Uma edição real não é aprovada por resume.
3. Health, 25 slots/contas, ordens completas, TPs, no máximo 1 BUY,
   fills reconciliados, mês, caps, flags e parents íntegros.
4. Abertura do engine condicionada a `strategy_config_pending=false`; mudança
   concorrente/CAS perdido rebloqueia exclusivamente esse engine.
5. Evento LIVE_RESUMED/VERIFIED_READ_RECOVERY e checagem independente Watchdog
   antes de encerrar. Permissão/configuração/financeiro ambíguo não passa.

## Validação e publicação

Regressões exercitam o servidor real: 503→vazio válido, exaustão com checkpoint
e sem bloqueio de edição, permission/schema sem retry, config/cap ausentes ou
inválidos, edição pendente/blocked ou chegada durante Binance, TP ausente,
incidente/CAS alterado, mesma conta/símbolo em engines/shards distintos.
Relatório v22 exporta o contrato; ausência de prova não vira PASS.

Somente web/control plane. Observador read-only aceita o root `/opt/coinops/source`
do Executor 01 ou `/opt/coinops/current` de shards novos, confirmado pelo systemd.
Default legado de shard só pode ser 01; sempre conferir IP e engine registry.
Não precisa migration ou restart VPS, nem troca de credencial. Após main/READY,
aguardar cron oficial e confrontar novamente Binance/ledger/engine/Watchdog.
Nunca provocar trade em Production para teste. Rollback preserva histórico.
