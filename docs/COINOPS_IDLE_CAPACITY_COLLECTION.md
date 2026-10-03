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
