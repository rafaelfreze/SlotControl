# Coleta ociosa por minuto UTC — 03/10/2026

O cooldown móvel de 60s não coincidiu com os buckets UTC usados pela média
de máximos por minuto. Com cron alternando 60,1s/59,9s, o segundo tick era
ignorado. Reprodução offline de 32 ticks manteve apenas oito amostras após
aquecimento. Executor 03 vazio confirmou 3/3/4/3 e depois oito amostras; não
era falta de headroom Binance. Ausência de evidência bloqueou corretamente.

`sampleIfIdle` agora limita tentativas ao minuto UTC da coleta. Tráfego real
com header válido nesse mesmo minuto dispensa o probe. Um probe em andamento
é compartilhado mesmo na fronteira de minuto; falha não repete no mesmo bucket.
Só GET público `/api/v3/time`, timeout 4s, sem credencial ou ordem. Não há
cron novo, polling no browser, backfill, weight zero fictício ou retry extra.

A janela continua 15min, >=15 máximos de minutos realmente observados,
limite 6000, reserva única 35%, incremento conservador 900 e histerese 10min
saudáveis para reabrir. Gap real permanece fail-closed. REAL/Testnet têm hosts
e evidência isolados; Testnet continua desativada pela política vigente.

Regressões cobrem três padrões de jitter, 01/02/03/futuro04, concorrência,
fronteira de minuto, tráfego ativo, relógio recuando, falha/header ausente e
expiração. Apenas a camada observacional muda; Strategy Engine, ordens, caps,
contas, posições, TP, NEXT BUY e histórico permanecem fora da correção.

Como o arquivo pertence ao grafo comum de runtime, publicar release pelo
manifest e atualizar 01 → 02 → 03 sequencialmente. Antes/depois de cada restart,
validar health exato, motores/reconciliação, proteções, incidentes e Watchdog.
Paridade total e evidência real devem preceder certificação do 03 vazio.
Nenhuma certificação ou prontidão é inferida dos testes offline.

## Validação e rollout autorizado

Runtime publicado: `0f5c1071f30f3859379e3b7ce01b4a9fac9be724`.
Manifest comum: `89e303e4a6ef2ef80fdece0aab450b9bf464f25e`.
Node `v24.21.0`, 23 arquivos transitivos, fingerprint
`dfd5888668f364dd439589120346227bf475c8d4d6f2f429a26bcbc2ef879879`.

106 testes do executor, 18 testes de configuração/health web e 45 de capacidade
(22 em PostgreSQL local descartável): PASS. Lint dirigido, typecheck e build
isolado Next 14.2.35: PASS. Os mocks de dois testes anteriores à aposentadoria
Testnet foram atualizados; fixtures históricas permanecem exclusivamente offline
e nova regressão comprova que o coletor atual não consulta/persiste Testnet.

Os três serviços foram atualizados sequencialmente, com assets diretamente do
GitHub e os deploys oficiais. Início dos processos UTC em 03/10: 01 22:07:17,
02 22:09:16, 03 22:11:25. Antes de avançar, cada shard confirmou HEALTHY,
reconciliação pós-restart e proteções. Nenhum restart simultâneo ou automático.
Snapshot 22:20:23: 13 engines/runs ativos, hashes de estratégia/ordens residentes/
posições inalterados, 13 NEXT BUY, zero posição sem TP, zero incidente,
Watchdog HEALTHY 7+6+0, 03 sem contas. Logs warning/error pós-restart: zero.

A janela de compatibilidade web é explícita, somente SHA/horários, por shard:
0681027 → 0f5c107, 22:05:02–22:45:02 UTC. Após o fim, o resolver aceita apenas
0f5c107 em cada requisição, sem novo deploy ou extensão automática. Overrides
version-only preservam os JSONs sensíveis, HMACs e demais credenciais existentes.
Deploy web Git oficial `dpl_Dbc8MeQcWFzuRPJfNhTNytXmeY6b`: READY.

A evidência final de amostras/histerese/certificação está no fechamento do
`COINOPS_EXECUTOR_03_DELIVERY.md`; estes testes não substituem os gates reais.
