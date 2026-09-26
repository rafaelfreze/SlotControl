# CoinOps: auditoria de isolamento e escala (2026-09-25)

Status: **COINOPS_50_ACCOUNTS_READY = REPROVADO**. Este documento separa
evidência medida de projeção. Nenhuma falha foi induzida na Production e
nenhuma ordem foi criada ou cancelada nesta auditoria.

## Topologia verificada

- Vercel Cron chama `/api/cron/live-execution` a cada minuto, com duração
  máxima configurada de 60 s. Descobre runs ACTIVE/PAUSED e chama
  `advanceLiveRun` de todos via `Promise.all`, sem limite de concorrência.
- Cada run usa lease próprio em `robot_v1_live_runs`; falhas tratadas por
  `advanceLiveRun` acionam kill switch e alerta do engine, não de toda conta.
  O cron agrega uma falha local como `PARTIAL_FAILURE` HTTP 503.
- Executor VPS usa registro estático + dinâmico, roteia por
  operator/account/engine/market e referencia credencial de cofre por conta.
  A criação de ordens usa idempotência persistente e consulta antes de
  repetir uma resposta incerta.
- O navegador assina Realtime por contexto selecionado, não por slot. Em
  "Todos", porém, adiciona um filtro por engine; o carregamento inicial
  também solicita health por engine. Não há medição de 100 engines no
  navegador nem prova de ausência de vazamento/assinatura órfã em longa duração.

## Falha sistêmica encontrada e corrigida localmente

Antes, uma referência inválida em **uma** conta do registro dinâmico fazia
o registro combinado inteiro falhar e o executor voltar apenas às contas
estáticas. Assim, uma conta nova defeituosa retirava as outras contas
dinâmicas saudáveis do roteamento. Agora a validação separa as entradas por
conta; rejeita o grupo inválido, conserva os irmãos válidos e valida o
conjunto final. Referências cruzadas e IDs duplicados continuam proibidos.

Regressão sintética: 10/30/50/100 contas com 2 engines por conta, mais
2 engines estáticos, verificando roteamento da conta saudável final. O
cenário de 100 contas rejeita corretamente cinco contas com credencial
ausente e mantém os 95 grupos saudáveis. A carga corresponde a
500/1.500/2.500/5.000 **slots lógicos** no teste de registro. Um segundo
teste percorre 2.500 e 5.000 slots sintéticos pelas funções reais de preço
de BUY, TP, reentrada e identidade idempotente de ordem; não cria slots
persistidos, fills reais, ordens Binance ou ciclos executados. Os 36 testes
do pacote `live-executor` passaram.

O arquivo JSON dinâmico continua sendo um ponto único: se estiver ilegível
ou não puder ser decodificado, todas as contas dinâmicas falham fechadas.
As operações administrativas de escrita também validam o arquivo inteiro.
Essa correção local ainda não foi implantada no executor LIVE.

## Medições e limites

| Perfil | Medido | Resultado |
| --- | --- | --- |
| 10 contas / 20 engines | Merge do registro em memória | p50 0,48 ms; p95 0,97 ms; RSS do processo 51,6 MB |
| 30 / 60 | Merge do registro em memória | p50 0,97 ms; p95 9,28 ms; RSS 52,7 MB |
| 50 / 100 | Merge do registro em memória | p50 1,42 ms; p95 1,96 ms; RSS 53,8 MB |
| 100 / 200 | Merge do registro em memória | p50 2,99 ms; p95 8,1 ms; RSS 53,9 MB |
| Banco atual | Snapshot read-only | 4 accounts, 12 engines, 6 runs ACTIVE/PAUSED, 200 slots de múltiplos ciclos, 34 ordens, 8.756 eventos, 0 alertas abertos |
| Cron atual | Logs read-only recentes | Minutos amostrados: 6 runs OK; não extrapola para 100/200 engines |

As latências e o RSS acima medem **somente o merge local do registro**, não
CPU/RAM do executor sob reconciliação, rede, Binance, Supabase ou push. O
snapshot do banco e os logs representam apenas o momento consultado.

## Riscos não aprovados

1. `Promise.all` dispara 100–200 runs simultâneos no cron de 60 s.
   Não há fila limitada, fairness nem medição de backlog/cron overlap em carga.
2. O snapshot do executor faz até seis leituras Binance em paralelo por
   engine e pode repetir um snapshot após falha transitória. Não existe
   orçamento de REQUEST_WEIGHT compartilhado por IP/credencial. O adapter
   read-only repete HTTP 429 após 100 ms, sem respeitar `Retry-After`.
3. O ledger emite `RECONCILED` por run/minuto. A 100 engines, isso
   projeta aproximadamente 144 mil eventos/dia, **não medidos**. Uma query
   de eventos acumulou 1.853 chamadas com média histórica de 486,6 ms em
   `pg_stat_statements`; o período de coleta e p95 não foram apurados.
   Causa da latência ainda não provada.
4. O Realtime usa um canal, mas até um filtro por engine selecionado;
   limites reais dependem do plano e do tráfego. Não foi medido o comportamento
   de 2.500 slots nem o retorno de background em 100 engines.
5. Não houve harness ponta a ponta de milhares de fills, TPs, resets,
   crash/restart, resposta incerta, alertas push, RLS e recovery simultâneo.
   Portanto não existem p50/p95/p99, backlog e tempo de recuperação
   confiáveis do fluxo completo.

## Gates

| Gate | Estado |
| --- | --- |
| MULTI_ACCOUNT_ISOLATION_PASS | Parcial: roteamento/credenciais sintéticos; falta execução concorrente |
| ENGINE_BLAST_RADIUS_PASS | Parcial: 1 e 5 contas inválidas isoladas no registro; faltam falhas de operação |
| BINANCE_RATE_LIMIT_PASS | Reprovado |
| SCHEDULER_CONCURRENCY_PASS | Reprovado |
| RECOVERY_AT_SCALE_PASS | Não testado |
| DATABASE_SCALE_PASS | Não comprovado |
| REALTIME_SCALE_PASS | Não comprovado |

Próximo gate técnico: harness totalmente sintético do cron e executor,
com latência, memória, REQUEST_WEIGHT, falhas 1/5/credencial, fairness,
restart e 2.500 slots reais em fixture. Só então limitar concorrência e
otimizar consultas conforme gargalos medidos. Não modificar ordem LIVE para
obter benchmark.

## Continuação medida em 2026-09-26 (não substitui os gates)

O patch de isolamento do registro dinâmico foi integrado a GitHub/main em
`47a62b0`; `a3c3c4e` tornou a fixture privada no Linux. No VPS, os 36 testes
do executor passaram em Node 24; o checkout e o processo LIVE foram atualizados
para `a3c3c4e` em 26/09, com restart único após verificar zero claims pendentes.
O novo PID 86498 respondeu healthy, e às 13:05 UTC os seis motores LIVE tinham
reconciliação recente, kill switches desligados, zero alertas, uma BUY residente
por motor e 1/1/2/2/1/1 TPs no ledger (Thyely BTC/SOL, Rafael BTC/SOL,
Caixeta BTC/SOL). Vercel `dpl_2wznTHPavCfH1BxKWKdMZwiZFiYL` ficou READY;
cron pós-restart retornou `COMPLETED`. Nenhuma ordem foi usada como teste.

- O harness HTTP real do executor, contra uma Binance fictícia no próprio VPS,
  observou 50/100/2.500 em 2.128 s (GET p50/p95/p99 de 237/251/252 ms,
  RSS 133→147 MB), e 100/200/5.000 em 4.171 s (240/283/292 ms,
  RSS 148→156 MB), com 100 ms de latência fictícia por chamada. Esses são
  **slots lógicos**; o harness não executa `advanceLiveRun` nem Supabase.
- Um segundo harness executou claims duráveis `MARKET → TP → NEXT BUY` em
  `/tmp` no VPS: 50/100/2.500 slots de fixture, 300 ordens fictícias únicas,
  363 ms de parede, p50/p95/p99 por engine 42/60/61 ms, RSS 66→76 MB;
  100/200/5.000, 600 ordens únicas, 793 ms, p50/p95/p99 40/84/88 ms,
  RSS 76→79 MB. Perda da resposta após MARKET em 1 engine, 5 engines e uma
  credencial inteira recuperou 1/5/2 claims por evidência fictícia exata;
  nenhum segundo POST. Não simula RPCs de ciclo/slot, fills ou Binance real.
- PostgreSQL 17 isolado na máquina de desenvolvimento, com 100 contas,
  200 engines, 5.000 linhas de slots e 288.000 eventos sintéticos, executou
  144.567 transações em 30 s a 12 clientes/4 threads: 4.868 TPS,
  2,462 ms de média, 0 falhas. Amostra de 7.527 transações:
  p50/p95/p99 2,054/3,152/6,163 ms. Em 50/100, 5.161 TPS e 0 falhas;
  amostra p50/p95/p99 2,069/3,280/6,584 ms. Não cobre RLS, PostgREST,
  rede ou limites do Supabase gerenciado; a instância de benchmark foi parada.
- No Supabase real, uma consulta PostgREST de eventos por contexto tem 1.965
  chamadas históricas, média 535 ms e máximo 3.556 ms, apesar de EXPLAIN
  direto via índice `(run_id, observed_at desc)` executar em 0,455 ms.
  O efeito de RLS/PostgREST sob carga não foi isolado; não criar índice ou
  migration por suposição.
- Um minuto de logs sanitizados do processo LIVE atual, com 6 engines, mostrou
  44 `READ_STATE` e 14 `READ_TRADES`. A amplificação é material: projetar
  100 engines/minuto a partir dela excederia amplamente o orçamento do IP.
  A versão atual de Vercel retorna `COMPLETED` para os 6 engines; isto não
  demonstra cron de 100 engines dentro dos 60 s disponíveis.
- O limitador de leituras por IP, single-flight por credencial e filtro
  Realtime único por contexto foram implementados **somente na branch de
  auditoria**. Os testes sintéticos de 50 contas inicialmente reprovaram por
  peso de `exchangeInfo`; cache público de filtros por 1 s corrigiu o
  snapshot inicial de 50/100. A 100 ms de latência fictícia, um snapshot de
  100/200 também passou graças à coalescência; a resposta imediata, sem
  coalescência temporal, falhou em 100/200. Mais importante, cinco snapshots
  por engine (sem ordens e sem RPCs) esgotaram o orçamento: 30/60 teve 48
  engines saudáveis e 12 afetados; 50/100 teve 48 saudáveis e 52 afetados;
  100/200 teve 48 saudáveis e 152 afetados. O harness cobriu 260 snapshots
  completos em 50/100 antes de bloquear novas leituras. Falhar 1 ou 5 engines
  sob essa pressão não isola o efeito, pois o IP já estava saturado. O cron
  real observou 44 snapshots para apenas seis engines em um minuto. Logo,
  a arquitetura ainda não sustenta 50/100 em cadência de um minuto; publicar
  o limitador agora apenas bloquearia motores. Limitador/cache/pool não foram
  publicados em Production.

### Estado dos gates após esta rodada

| Gate | Estado honesto |
| --- | --- |
| MULTI_ACCOUNT_ISOLATION_PASS | Roteamento e GET sintético 1/5/conta passaram; patch LIVE implantado e seis engines reconciliados, mas não comprovado em 50 contas LIVE |
| ENGINE_BLAST_RADIUS_PASS | PASS apenas no harness HTTP/claims; falta fluxo real de cron/ledger sob falha |
| BINANCE_RATE_LIMIT_PASS | REPROVADO: snapshot 100/200 excede o teto; cron 50/100 completo não medido |
| SCHEDULER_CONCURRENCY_PASS | Pool limitado e fairness passaram em teste; cron 50/100 dentro de 60 s não comprovado |
| RECOVERY_AT_SCALE_PASS | Claims passaram em 50/100 e 100/200; ciclo/ledger/restart de processo completos não comprovados |
| DATABASE_SCALE_PASS | Banco local sintético passou; Supabase gerenciado/RLS/PostgREST não comprovados |
| REALTIME_SCALE_PASS | Um filtro por contexto passou em teste; longa duração/browser/RLS em carga não comprovados |

`COINOPS_50_ACCOUNTS_READY` permanece **REPROVADO**. O próximo gargalo
objetivo não é RAM do VPS: é o número de snapshots/leituras Binance por engine
por minuto e o cron de 60 s. Reduzir leituras redundantes sem reutilizar estado
desatualizado depois de fill/order write; medir peso real/minuto, p99 e idade de
reconciliação sob 100 engines em ambiente isolado. Somente se a cadência não
couber após essa redução, dividir a execução em workers/IPs com filas e
leases por engine. Não usar Production como gerador de carga.

### Continuação: no-op resident e duas leituras sintéticas

Em 26/09, o IP do executor consumiu 3.755 unidades de `REQUEST_WEIGHT`
num minuto observado com seis engines LIVE; o cron produziu 44 `READ_STATE`,
14 `READ_TRADES` e 14 `QUERY_ORDER`. O header da Binance agrega todo o tráfego
do IP e não atribui sozinho o peso ao CoinOps. As contagens do executor
demonstraram leituras redundantes: ordens `NEW` intactas eram sincronizadas
com histórico de trades a cada minuto.

O commit `6bfac1a` foi integrado em main, mas a primeira condição de atalho
não funcionou porque o ledger mantém `trades_reconciled=false` em ordens
residentes `NEW`. A correção `64802c4` usa identidade, símbolo, lado, preço,
status `NEW`, guard de submissão e quantidade/quote executadas zero; qualquer
fill ou divergência segue a reconciliação completa. Testes, lint, typecheck e
build passaram, e o deploy Vercel `dpl_DAaDNbtRj3Uu4hkg7D9jXFjvHVHq`
ficou READY. No minuto pós-deploy, seis motores tiveram 14 `QUERY_ORDER`,
zero `READ_TRADES` e 30 `READ_STATE`; o peso observado às 13:34:16 UTC foi
2.469, contra a amostra prévia de 3.755. O cron 13:34 completou e o ledger
mostrou seis runs ACTIVE reconciliados, sem `last_error`, cada um com uma BUY
e 1/1/2/2/1/1 TPs. Isso valida a redução de leituras, não capacidade de 50
contas nem a corretude matemática de todas as ordens.

No harness HTTP sintético de duas leituras por engine, 50 contas/100 engines/
2.500 slots lógicos completaram 200 snapshots em 4,29–4,39 s, sem afetados;
falhas de 1 engine, 5 engines e uma credencial afetaram somente 1, 5 e 2
engines, respectivamente. Em 100 contas/200 engines, 20 engines foram
bloqueados pelo orçamento experimental de leitura por IP. A otimização de
snapshots do fluxo web e o cache privado de 1 s permanecem **somente na branch
de auditoria**; esses números não são teste ponta a ponta de 100 ciclos de
`advanceLiveRun` com Supabase, fills e recovery. O gate final continua
**REPROVADO** até throughput, backlog, RLS, Realtime e recuperação completa
serem medidos sem risco para Production.

### Harness expandido no VPS: health, ordens e snapshots

O harness anterior subestimava a carga por não chamar `/v1/health` e
`/v1/query-order`. A continuação na branch de auditoria incluiu uma health,
duas consultas de ordem e dois snapshots por engine, Binance completamente
fictícia com 100 ms por endpoint, pool de 12, limites de peso ativos,
`tradingEnabled=false` e `killSwitch=true`, em `/tmp/coinops-scale.TRj0Zt`.
Nenhuma credencial ou ordem real foi usada.

| Fixture | Resultado | Parede | p50/p95/p99 por engine | CPU | RSS final |
| --- | --- | ---: | --- | ---: | ---: |
| 40 contas/80 engines/2.000 slots | 80/80 | 8,87 s | 1.231/1.627/1.643 ms | 2,57 s | 149 MB |
| 50 contas/100 engines/2.500 slots | 100/100 | 10,35 s | 1.155/1.209/1.210 ms | 2,04 s | 140 MB |
| 100 contas/200 engines/5.000 slots | 108/200 | 11,35 s | 1.110/1.165/1.179 ms por tentativa | 2,81 s | 139 MB |

No cenário 50/100, o simulador contou 1.003 chamadas fictícias, incluindo
300 `apiRestrictions`, 50 `account`, 200 `order` e 200 `openOrders`;
aproximadamente 4.209 unidades de peso pelos pesos codificados no harness.
Isso representa 87,7% do orçamento preventivo de 4.800/min e não inclui
fills/TPs/retries/cancelamentos reais. Em 100/200, 92 engines foram afetados
pelo orçamento; portanto a margem de 100 contas **não passou**. Em 50/100,
falhas simuladas de 1 engine, 5 engines e uma credencial afetaram exatamente
1, 5 e 2 engines; os demais concluíram.

Uma fixture adicional de 40/80 fez 160 snapshots, 160 consultas de ordem e
80 health em 8,87 s, com aproximadamente 3.470 unidades de peso (72,3% do
orçamento preventivo). Assim, **40 contas/80 engines são somente a capacidade
com margem do transporte HTTP sintético**, não a capacidade operacional
aprovada do servidor. Production comprovada ainda tem três contas/seis
engines; a cadência, Supabase, fills e recuperação a 40/50 contas reais não
foram validados. Gatilho objetivo para escalar: peso IP p95 ≥ 4.800/min,
cron p99 ≥ 45 s, ou idade de reconciliação ≥ 120 s. Não adicionar conta a
Production sob a premissa de que este benchmark sozinho aprovou o gate.
