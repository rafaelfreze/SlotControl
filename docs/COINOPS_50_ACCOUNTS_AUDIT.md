# CoinOps: auditoria de isolamento e escala (2026-09-25 a 2026-09-26)

Status: **COINOPS_50_ACCOUNTS_READY = NÃO COMPROVADO**. Este documento separa
evidência medida de projeção. Nenhuma falha foi induzida na Production e
nenhuma ordem foi criada ou cancelada nesta auditoria.

## Baseline atual: 26/09/2026, 16:23–16:27 UTC

- Production: **4 contas / 7 motores ACTIVE**, incluindo Pedro/SOLBRL.
  Rafael BTCBRL/SOLBRL, Thyely BTCUSDT/SOLUSDT, Caixeta BTCBRL/SOLBRL e
  Pedro SOLBRL tinham conta/engine/run ACTIVE, kill switches desligados,
  `last_error` nulo, 25 slots por run e nenhum alerta aberto. O ledger tinha
  **7 BUYs residentes e 9 TPs para 9 posições OPEN**. O cron Vercel completou
  os sete reports em minutos consecutivos. É uma fotografia, não substitui
  conferência individual das ordens diretamente na Binance.
- Testnet de Rafael: dois runs ACTIVE (BTCUSDC/SOLUSDC), 25 slots cada,
  reconciliados às 16:27 UTC. Os ciclos COMPLETED permanecem históricos.
- Banco `coinops`: 5 contas cadastradas no total (incluindo Testnet),
  13 engines cadastrados, 7 runs LIVE ACTIVE, 225 slots LIVE entre ciclos,
  37 ordens LIVE e 14.091 eventos estimados; apenas 175 slots pertencem aos
  sete runs LIVE ativos. Conexões observadas: 34/60, sendo 30 client backends
  idle. Não se deve extrapolar esta fotografia para 50 contas.
- Cron Production vigente: `boundedEngineMap` com concorrência **4** e
  captura de falhas por engine. A versão de fairness `fbae657` na branch
  `codex/coinops-scale-completion` não foi integrada: ela também altera o
  cron e eleva concorrência a 12, **além de remover a recuperação verificada
  de falha transitória de leitura presente na main**. Integrar a branch
  inteira seria regressão operacional. O limite de peso por IP e o fluxo
  completo a 100 engines ainda não estão aprovados. Um teste de regressão
  cobre nominalmente os sete motores atuais e a falha de Pedro, cinco engines
  ou uma conta inteira, sem atingir Binance.
- VPS executor: amostra 16:24:25–16:26:07 UTC, processo ~145,6→146,9 MB;
  CPU acumulada +4,95 s em 102 s de parede (~4,9% de um núcleo). Host de
  961 MB, 479 MB disponíveis e load médio 0,21 no primeiro instante. O
  `REQUEST_WEIGHT` compartilhado do IP atingiu **3.600 e 3.628 unidades** em
  dois minutos observados (média 3.614; pico 3.628), contra o limite Spot de
  6.000/min indicado pela Binance em `exchangeInfo`
  ([documentação oficial](https://developers.binance.com/en/docs/products/spot/rest-api)).
  Headroom instantâneo no pico: 2.372 unidades até o limite e
  1.172 até o orçamento preventivo experimental de 4.800. Esses valores
  incluem qualquer outro cliente no IP; não são p95 nem capacidade por motor.
  No mesmo intervalo o executor registrou 106 `READ_STATE`, 32 `QUERY_ORDER`,
  6 `HEALTH`, zero `READ_TRADES` e 144 respostas HTTP 200 das leituras.
  `READ_STATE` teve p50/p95/p99 de 1.058/4.796/7.676 ms (106 amostras);
  `QUERY_ORDER`, 490/512/516 ms (32 amostras). Essas latências incluem
  chamadas do painel e não são a duração do cron.
  A média foi 53 snapshots e 16 consultas de ordem por minuto. A leitura
  anterior com seis motores, após o atalho de ordens residentes, registrara
  30 snapshots, 14 consultas, zero trades e peso 2.469 em um minuto; antes
  do atalho: 44/14/14 e 3.755. A diferença atual não pode ser atribuída só
  ao sétimo motor porque havia tráfego de painel/auditoria no IP.
- Supabase read-only: `pg_stat_statements` registra historicamente 3.269
  chamadas de uma consulta PostgREST a eventos LIVE com média ~827 ms e
  máximo 3.687 ms; a coleta do banco remonta a 24/07, portanto não é p95
  atual. Entre duas leituras desta auditoria, mais 55 chamadas somaram
  8.700 ms de execução (~158 ms/chamada), sem percentis individuais.
  Existe índice `(run_id, observed_at DESC)`. O banco Production não
  será usado para gerar 2.500 slots/altas taxas de escrita artificiais.

Os benchmarks posteriores de HTTP fictício, claims/restart e PostgreSQL
local da branch são evidência **parcial**, não prova de throughput do fluxo
Vercel → Supabase/RLS → executor → Binance sob 100 engines. O gate de banco
gerenciado permanece não comprovado; antes de criar qualquer Supabase Branch
cobrável, usar apenas leitura Production e Postgres local isolado. Se a
prova de escrita/RLS/PostgREST gerenciado a 2.500 slots não puder ser obtida
sem recurso externo, marcar `DATABASE_SCALE_PASS=BLOCKED_EXTERNAL_RESOURCE`.

### Ensaios não destrutivos já concluídos na branch de auditoria

Os resultados abaixo vieram de `codex/coinops-scale-completion` até
`fbae657`; não foram reexecutados nem implantados por esta atualização.
Binance era fictícia, `tradingEnabled=false` e `killSwitch=true` no harness.

| Cenário | Resultado medido | Limite da prova |
| --- | --- | --- |
| 50 contas/100 engines/2.500 slots, health + 2 consultas de ordem + 2 snapshots por engine | 100/100, parede 10,35 s, p50/p95/p99 por engine 1.155/1.209/1.210 ms, CPU 2,04 s, RSS 140 MB; ~4.209/4.800 unidades do budget preventivo | 87,7% do budget sem fills, TP ou retries; margem insuficiente para aprovar 50 |
| 100/200/5.000 no mesmo cenário | 108/200, 92 afetados pelo budget | Margem de 100 contas reprovada |
| 50/100 com apenas um snapshot + health | 100/100, 4,60 s, p50/p95/p99 497/639/653 ms, CPU 1,65 s, RSS 135 MB | Otimização de snapshot não publicada; não inclui DB/cron |
| 100/200 com apenas um snapshot + health | 200/200, 8,11 s, 473/556/574 ms, CPU 2,26 s, RSS 146 MB | Dois snapshots no mesmo perfil caem a 156/200 |
| 50/100 e 100/200 com restart entre TP fictício e ACK | 300/600 ordens únicas, 0 duplicação no replay; 376/941 ms | Claims locais, sem RPCs do ledger/cron |
| 50/100 com falha de 1 engine, 5 engines e uma credential de dois engines | 99, 95 e 98 saudáveis, respectivamente | Isolamento HTTP/registro, não pipeline completo |
| PostgreSQL 17 local, 50/100 e 100/200 | 5.161/4.868 TPS, 0 falhas, p95 3,280/3,152 ms | Banco local sem PostgREST/RLS gerenciada |

Outro ensaio HTTP com pool 12 mediu fila p50/p95/p99 de 2,60/4,38/4,70 s
em 50/100 e 4,17/7,70/8,24 s em 100/200. São métricas do transporte
isolado, não backlog nem p99 do cron Production. A simulação de fairness
`fbae657` diminuiu o máximo de rodadas perdidas num deadline parcial de
20 para 1 (100 motores/80 atendidos) e de 120 para 2 (200/80), mas não
aumenta throughput nem prova segurança sob o limite de peso atual.

### Gates após atualizar para quatro contas e sete motores

| Gate | Estado atual | Evidência faltante |
| --- | --- | --- |
| MULTI_ACCOUNT_ISOLATION_PASS | Parcial | Isolamento genérico e dos sete nomes no pool; falta fluxo completo de falha simultânea com DB/cron |
| ENGINE_BLAST_RADIUS_PASS | Parcial | HTTP/registro sintético 1/5/credencial; falta confirmação de recovery/push no pipeline completo |
| BINANCE_RATE_LIMIT_PASS | Não comprovado | Dois minutos reais ~3,6k/6k; budget experimental falha em 100/200 e 50/100 não tem folga para fills/retries |
| SCHEDULER_CONCURRENCY_PASS | Parcial | Sete runs completam em Production com pool 4; fairness `fbae657` só sintético, cron real 100/200 não medido |
| RECOVERY_AT_SCALE_PASS | Parcial | Claims fictícias passaram em 100/200; falta recuperação simultânea do ledger/cron/RLS após crash |
| DATABASE_SCALE_PASS | BLOCKED_EXTERNAL_RESOURCE | Postgres local e leitura Production não provam escrita PostgREST/RLS gerenciada a 2.500 slots; não criar branch paga |
| REALTIME_SCALE_PASS | Parcial | Contexto/filtro e RLS examinados; falta 100/200 engines em navegador com reconexão e sem vazamento |

Capacidade operacional **comprovada** permanece em 4 contas/7 engines LIVE;
o teste HTTP isolado de 40 contas/80 engines com 72,3% do orçamento
preventivo é somente margem do transporte fictício. Ampliar servidor ou
adicionar worker só após medir cron p99 ≥ 45 s, idade de reconciliação ≥
120 s, peso IP p95 ≥ 4.800/min ou backlog crescente. O uso de memória
observado não justifica escalar por si só.

## Baseline histórico de 25/09 (substituído pelos dados atuais acima)

## Topologia verificada

- Vercel Cron chama `/api/cron/live-execution` a cada minuto, com duração
  máxima configurada de 60 s. O `Promise.all` sem limite descrito na auditoria
  original foi substituído por pool limitado a quatro engines em Production.
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
