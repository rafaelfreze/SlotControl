# Trading normal sem dependência do Watchdog

## Evidência e limites da auditoria

Leitura Production em 05/10/2026, janela de 24h encerrada aproximadamente às
12:38 UTC; complemento de sete dias. Produto CoinOps, projeto
`otdfpmsegjxpqrzisfmi`, schema `coinops`. Git inicial `adb2f001`.
Não foram disparadas operações financeiras para reproduzir falhas.

| Episódio UTC | Evidência | Diagnóstico |
| --- | --- | --- |
| Dete/BTCBRL, executor-02, 04/10 19:48–20:50 | STALE → ARM_ENTRY_FAILED → SUBMISSION_OUTCOME_UNKNOWN; três registros, um episódio | Watchdog entrou 35s após RUN_ACTIVATED, antes da primeira execução normal. Falha posterior de dispatch já recebeu correção em `65f2e382`; recuperação VERIFIED_READ_RECOVERY pelo cron normal às 20:50:31. Não repetir recuperação/restart. |
| Samya/BTCUSDT, executor-03, 05/10 07:00–07:01 | RECONCILE_ORDERS_FAILED → RECOVERED | QUERY_ORDER retornou HTTP 503 / EXECUTOR_ORDER_QUERY_FAILED em 7.466ms. Código nomeado não pertencia à allowlist de retry; primeira leitura falha promovida a bloqueio. Retomada pelo cron normal às 07:01:18. |

Samya: engine `8464c3b3-62ac-4a52-b2f1-c4bf4bd6ed36`, run
`0cf2b890-5bb2-4563-83f0-5a4117562d32`, request
`cf8d95d1-500f-42ca-8ea1-8926355aa71d`. Journal prova o HTTP do executor,
não o HTTP/código original da Binance, que não foi preservado. Não atribuir a
rate limit ou timeout Binance por inferência. Último evento financeiro anterior
às 01:24:13 UTC; portanto não foi um erro imediatamente após gain/fill.

Na janela: sete gains, dois RUN_REANCHORED, duas recuperações pelo fluxo normal,
uma invocação de reconciliação pelo Watchdog durante ativação. Nenhuma intervenção
correlacionada aos sete gains. A antiga UI chamava qualquer RECOVERED com horário
de tentativa de "auto-recuperação", incluindo VERIFIED_READ_RECOVERY do cron.

Sete dias: nove registros; STALE repetiu três vezes em ativações vazias (Samya SOL
03/10 23:04, Samya BTC 23:19, Dete BTC 04/10 19:48), dentro de 5–35s da ativação.
SUBMISSION_OUTCOME_UNKNOWN apareceu duas vezes. EXCHANGE_ORDER_MISSING de 28/09
e UNKNOWN de 29/09 não conservaram causa upstream suficiente: permanecem
INVESTIGATE no registry, não recebem fix presumido. Contagens são episódios,
não quantidade de gains nem prova causal.

## Contrato corrigido

- Leitura de health/state/ordem/trades: até quatro tentativas para códigos
  transitórios permitidos e HTTP 502/503/504, ou erro de rede/timeout. Backoff
  500/1000/1500ms, sem aumentar timeout. Ownership/permissão/paginação inválida
  nunca recebem retry permissivo.
- Falha persistente da observação: checkpoint durável, código original, etapa,
  endpoint, tentativas, HTTP e origem. O cron normal retoma pelo mesmo lease.
  Após cinco minutos sem convergência, mantém fail-closed no motor afetado.
  Episódio resolvido anterior não reutiliza relógio antigo.
- Ordem já reconhecida e temporariamente ausente: até três GETs da identidade
  exata, separados por 250/500ms. Ausência persistente continua fail-closed.
  GET vazio não autoriza POST, cancelamento, adoção ou ordem de outro engine.
- Retry parcial não atualiza last_reconciled_at. Somente conclusão completa
  marca freshness. O Watchdog continua detectando paralisação real.
- Lease de trabalho normal: RECONCILING, não RECOVERING. Primeiro run vazio tem
  janela única de 90s desde o primeiro RUN_ACTIVATED imutável (ou criação do
  sucessor), permitindo o cron de um minuto com jitter. Não há grace para OPEN,
  ordem residente, gate fechado ou critical. Após 90s, STALE normal.
- Gain, sucessor, TP e NEXT BUY conservam RPCs financeiras, clientOrderId,
  locks e idempotência existentes. Nenhuma estratégia/ordem foi alterada.

Watchdog permanece fallback de crash, infraestrutura, interrupção, persistência
e ambiguidade. Ele não inventa recuperação nem uma segunda Strategy Engine.

## Conhecimento e SLO

Migration `20261005124719_add_incident_knowledge_and_trading_slo.sql` adiciona
registry server-only com RLS, ocorrência única por incident_id, assinatura
code/root/stage, causa, runbook, contadores, versão/teste e status. Trigger de
auditoria vincula engine/account/operator; não altera tabelas financeiras.
Assinatura FIXED que reaparece após fixed_at vira RECURRENCE_REGRESSION/HIGH;
o incidente operacional continua aberto pelo fluxo normal, nunca ocultado.
Histórico genérico sem root comprovado não é marcado FIXED.

TRADING_FLOW_OWNER atribui cada gain/fill a ENGINE/WATCHDOG. Falha de gravação
não interrompe proteção; deixa evidência ausente (UNKNOWN). Eventos e diagnósticos
aparecem nos exports v18 existentes. O resumo administrativo calcula no banco,
sem truncar em mil registros:

`NORMAL_TRADING_WATCHDOG_DEPENDENCY_RATE = 100 × eventos atribuídos ao Watchdog / (gains + observações únicas de fill positivo)`.

Se houver origem desconhecida ou denominador zero, taxa = NULL, não zero.
Fills parciais usam clientOrderId + quantidade acumulada + engine/run. Ganho e
fill são unidades distintas declaradas, não um lucro somado duas vezes.
Também: incidentes/100 gains, recoveries/100 gains, falhas/100 ciclos completos,
MTTR e assinaturas repetidas. Histórico anterior sem markers não fornece baseline
causal exato. Só observação natural pós-publicação mede o resultado real.

## Validação e publicação

Fixtures isoladas cobrem HTTP 503 nomeado, timeout, invisibilidade atrasada,
janela persistente, race de fill, ambiguidade, gain/sucessor/TP/NEXT BUY e crashes,
duplicate execution, engine A/B e shard 02/03. SQL usa PostgreSQL local descartável;
verifica dedupe, recorrência, RLS e >1000 eventos, nunca o banco remoto.

Aplicar migration aditiva uma única vez antes da web. Após READY, confirmar
SLO/admin, reconciliação natural, incidentes, TP/NEXT BUY e todos os shards.
Marcar apenas a assinatura comprovada FIXED com SHA e fixed_at da publicação
validada. Nenhuma amostra artificial nem trade de smoke.

Esta alteração não muda o grafo do executor (fingerprint comum
`a1ad68e6892405409f145d5035557b3959ecb3859cc5458bca83073697f623c8`),
portanto não exige restart/rollout VPS. Runtime anterior permanece isolado e
igual nos três shards. Rollback: release web anterior; manter registry/migration
aditiva como histórico e reabrir o status de engenharia se o fix for revertido.
