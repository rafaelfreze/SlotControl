# CoinOps — observação de permissões e recuperação segura

## Incidente real (11/10/2026)

Produto CoinOps, Supabase `otdfpmsegjxpqrzisfmi`, schema `coinops`, REAL.
Main inicial `d8ef622d518440a04d96d1ff6594f151d42d34b5`; runtime comum
`66543a8027b4af79ba2a1c4e85a69638b8b4e6db`.

| Motor / shard | Horário UTC do READ_STATE | Incidente / estágio |
| --- | --- | --- |
| Samya BTCUSDT / executor-03 | 15:07:17.836 | `046526b2-e4b6-4108-88ca-26134fdb4977`, ARM_ENTRY_FAILED |
| Thyely SOLUSDT / executor-01 | 15:08:28.640 | `b1c11d2b-f115-434d-8eda-f6c113348494`, CREDIT_SLOTS_FAILED |
| Elizelena SOLBRL / executor-02 | 15:06:36.092 e 15:07:07.128 | ARM_ENTRY_FAILED → RECONCILE_ORDERS_FAILED → RECOVERED às 15:08:46.434 |

Os três journals registraram HTTP 503 do **executor** e
`EXECUTOR_PRODUCTION_PERMISSION_DENIED`, exclusivamente em READ_STATE.
O HTTP/código original da Binance não foi conservado pelo código anterior.
Não afirmar timeout, 503 Binance, Earn, revogação de key ou rate limit como
causa histórica comprovada. O defeito comprovado é a perda de distinção entre
indisponibilidade da observação e permissão efetivamente insegura/negada.

Watchdog detectou os dois bloqueios restantes, sem recovery concorrente.
Os crons normais continuavam reconciliando, mas terminavam em KILL_SWITCH.
Os outros 14 motores estavam ACTIVE, reconciliados, sem kill switch local.

## Prova financeira somente leitura

Às 15:16 UTC, o observador oficial `observe-engine-incident.mjs`, executado
somente no shard proprietário, confirmou health SPOT_RESTRICTED, IP e runtime
corretos, seguido de `/v1/state`. Não executou create/cancel/test-order.

- Samya: 25 slots físicos, 3 OPEN, BTC locked 0.00033; TPs Binance
  67210608658, 67268970347, 67286556881; NEXT BUY 67350817971.
- Thyely: 25 slots físicos, 5 OPEN, SOL locked 1.886; TPs Binance
  17884454734, 17889827957, 17947663277, 17950256760, 17951648274;
  NEXT BUY 17951653793.
- Todos NEW, execução zero, clientOrderId/side/price/quantity coincidentes com
  ledger e namespace de cada engine. Zero fill terminal pendente e zero ordem
  PREPARED/UNKNOWN. Nenhuma ordem desses motores criada depois de 15:06 UTC.

## Correção permanente

Separar a observação GET de permissões de seu resultado de autorização.
`SPOT_RESTRICTED` exige todos os grants/flags válidos e account.canTrade=true.
Autenticação, flags ausentes/malformados ou permissão insegura permanecem
fail-closed. Transporte/gateway transitório comprovado usa
`EXECUTOR_PRODUCTION_PERMISSION_READ_UNAVAILABLE`, nunca permission-denied.

O snapshot de segurança descarta resultados parciais. Retry limitado consulta
novamente somente GETs; nenhuma tentativa envia ordem sem uma observação
completa e segura. A web usa o checkpoint de leitura existente, sob lease e
com janela de cinco minutos; não repete create-order/cancel-order ou crédito
financeiro. Permissão realmente negada nunca entra na allowlist de retry.
Evidência upstream deve conter somente endpoint fixo, HTTP e código numérico;
nunca URL assinada, payload, mensagem, token ou secret.

Somente os endpoints de observação já autorizados (`/v1/health`, `/v1/state`,
`/v1/query-order`, `/v1/trades`) reconhecem o novo código no retry limitado:
quatro tentativas com backoff 500/1000/1500 ms, sem aumentar timeout. Após
exaustão, o checkpoint `COINOPS_LIVE_TRANSIENT_EXECUTOR_READ` conserva endpoint,
HTTP, tentativas e evidência numérica sanitizada no contrato de relatórios v22.
Não inventa freshness ou conclusão financeira. Create/cancel têm uma única
tentativa de transporte, mesmo se receberem esse código.

Bloqueios legados só podem retomar pelo resume canônico após prova financeira
integral e CAS do mesmo alerta. Elegibilidade é restrita a ARM_ENTRY_FAILED ou
CREDIT_SLOTS_FAILED com etapa correspondente e root_code PERMISSION_DENIED
exato; o root code nunca entra no retry nem prova transiência histórica.
Além de health fresco, 25 slots, TP/ownership/caps e único incidente, exige uma
única BUY NEW sem fill; todas as ordens residentes com identidade, preço e
quantidade exatos, criadas mais de 90 segundos antes do incidente; nenhuma
ordem PREPARED/UNKNOWN/SUBMITTING/FAILED/PARTIALLY_FILLED, fill pendente,
intenção financeira recente/não concluída ou reserva de dispatch sem ACK.
Falha de qualquer prova mantém o gate fechado. Não limpar kill switch/alerta por SQL, nem
interpretar sucesso de health como prova suficiente de uma ordem incerta.
Watchdog confirma independentemente o estado final e encerra o incidente.

## Publicação e validação

Mudança do grafo de runtime exige release comum revisada em GitHub/main,
manifest com SHA completo e fingerprint e janela de versões limitada.
Aplicar deploy-legacy no 01 e deploy-shard nos demais, sequencialmente.
Antes e depois de cada restart: confirmar engine/ledger, TP, NEXT BUY,
reconciliação, incidentes e Watchdog; nunca dois restarts simultâneos.

Fixtures isoladas cobrem gateway/network, persistência, malformed/unsafe/auth,
estado parcial, zero POST sem autorização, retry GET-only, namespace por engine
e shard, CAS alterado e bloqueio financeiro ambíguo. A validação final exige
FLEET_PARITY_PASS, saúde/reconciliação real e zero gate indevido.
Nenhuma migration, credential, estratégia, capital ou ordem artificial é
necessária. Rollback conserva estado e segue o runbook oficial de shard.
