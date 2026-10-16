# Thyely100 — evidência isolada de reconciliação concentrada

Data: 16/10/2026. Escopo deste artefato: somente testes offline, sem credenciais,
sem Supabase remoto e sem escrita em Binance. Não é uma certificação de
capacidade nem uma evidência de ativação REAL.

## Implementação exercitada

`tools/testing/hundred-fills-reconciliation.test.mjs` executa:

- as funções canônicas `reconcileOrder`, `creditClosedSlots`, `runRows`,
  `ensureTakeProfits` e lease claim/renew do servidor LIVE, carregadas do código
  atual por transpile para isolar dependências;
- o transporte web real, sua política de observação/retry e o pool por invocação;
- `BinanceLiveTransport` real, com `fetch` totalmente simulado e bloqueio de
  qualquer método financeiro ou rota create/cancel;
- os corpos SQL versionados reais de sync de ordem, crédito de slot e ACK de
  orçamento, em PostgreSQL/PGlite somente em memória;
- `completeStrategyDecision`, ACK administrativo e descoberta paginada do
  registry reais, sobre o mesmo banco descartável.

O scaffold de schema/contexto é sintético e explícito. Ele não é o bootstrap
de Production nem substitui os testes de migration/RLS. As contas, UUIDs,
credenciais dummy e exchange responses pertencem exclusivamente à fixture.

## Casos direcionados

1. Cem TPs simultaneamente FILLED: 100 syncs, 100 gains, 100 decisões TP
   COMPLETED, 200 fills totais contando BUY pré-existente e SELL; replay não
   duplica fills, ganhos, principal nem reinvestimento.
2. Crash após o 37º sync durável: a próxima execução observa os terminais já
   reconciliados e termina os demais, sem duplicar efeitos financeiros.
3. HTTP503 antes da leitura de ordem: retry pelo transporte web real; não há
   repetição de submissão financeira.
4. Três503 intermitentes em ordens diferentes: convergência dentro do pool
   compartilhado por invocação.
5. Quarto503 distinto: erro tipado de observação após progresso parcial. Todos
   os workers em voo são drenados antes da falha retornar; nenhum GET ou SQL
   novo ocorre depois dela. A execução seguinte retoma os restantes e credita
   exatamente100 ganhos.
6. Crash após o 37º crédito durável: 37 ganhos persistem, os 63 seguintes
   convergem sem reaplicar os 37 anteriores.
7. Setenta e cinco fills com 25TPs ainda residentes: os 25 permanecem idênticos,
   sem cancelamento/recriação; o principal do engine irmão25 permanece intacto.
8. Lease expirado não autoriza sync, duas claims concorrentes têm um único
   vencedor e o planner canônico100 retorna uma única decisão NEXT BUY.
9. Checkpoint SQL real: o burst pode ceder antes de crédito/novas ordens, após
   prova completa de proteção. Repetição sem progresso não altera freshness;
   37créditos completos cedem, a próxima execução conclui63 e o release completo
   limpa o checkpoint sem duplicar gain. `last_reconciled_at` não é inventado.
10. Checkpoint é recusado antes de proteção TP ou com fills não reconciliados.
11. Teste de sensibilidade com delays assíncronos realmente aguardados e escala
    temporal10: REST600ms/SQL150ms simulados, pool observado de quatro workers.
12. Lease expirado dentro de transação longa é rejeitado pelo sync SQL usando
    `clock_timestamp()`, mesmo quando o `now()` da transação ainda é antigo.

O namespace C2 real impede que o engine irmão25, com a mesma conta/símbolo e
identificação de outro shard, adote a ordem do slot100. Isso prova o predicado
canônico local, não latência ou comportamento físico de dois processos remotos.

## Inventário efetivamente observado

O código canônico de cada request é exercitado. Os pesos REST são os mesmos
verificados no inventário versionado `variable-slot-weight-profile.test.mjs`;
não são quotas por minuto medidas em Production.

Com o contexto BNB fresco por invocação, a conclusão de decisão otimizada e o
pool limitado de quatro workers apenas para SELL já reconhecida, o inventário
da fixture com relógio lógico foi:

| Medida | Reconciliação100 TP | Até crédito/replay/verificações |
| --- | ---: | ---: |
| SQL round-trips executados | 1006 | 1414 |
| Syncs / renews / ACKs / decisões completas | 100 / 100 / 100 / 100 | 100 / 200 / 100 / 100 |
| Peso REST total | 2008 | 2116 |
| Peso em api.binance.com | 1960 | 2020 |
| Peso em data-api.binance.vision | 48 | 96 |

A fixture usa BNB fees positivos, não um atalho sem comissão. O relógio modelado
avança nos round-trips; houve renovação real do contexto BNB por TTL60s. Workers
concorrentes compartilham somente a cotação BNB, sem duplicar o refresh em voo.
Nenhum saldo, filtro, autorização ou openOrders é
reutilizado para autorizar ordem financeira.

Como contraste, antes da otimização de `completeStrategyDecision`, o mesmo
teste com registry real executava 1706 round-trips SQL na fase e 2114 até o
crédito. A diferença é a eliminação de resoluções duplicadas de autorização;
a resolução fresca não foi substituída por cache.

## Sensibilidade de duração, não benchmark Production

O relógio lógico padrão força a passagem do TTL da cotação BNB no código sob
teste. Ele não é um simulador exato de agenda distribuída e não é usado como
garantia de tempo de execução.

No teste paced, os timers realmente atrasam cada REST por60ms e cada SQL por
15ms; o relógio do código avança na escala10, correspondendo a600ms REST e150ms
SQL de premissa. O pool real teve pico4;100TPs convergiram em152,103s de tempo
modelado, com2062 de peso total (1990 api.binance.com,72 data-api). O tempo inclui
CPU/timers deste notebook multiplicados pela escala. Não mede CPU/RAM do VPS,
latência da Binance ou Supabase, nem certifica um SLO de Production.

O burst é seguido por checkpoint protegido antes do crédito/novas entradas.
Assim, essa fase de observação não é somada à fase de ganho/reciclagem no mesmo
tick. A continuidade usa as operações já persistidas como cursor, não reenvio.

## Comando reproduzível

Da raiz do checkout:

```powershell
node --experimental-strip-types --test tools/testing/hundred-fills-reconciliation.test.mjs apps/live-executor/test/variable-slot-ownership.test.mjs apps/web/lib/execution/variable-slot-runtime.test.ts apps/web/lib/slotgain/live-gain-continuation.test.ts
node --experimental-strip-types --test tools/testing/slot-workload-resource-probe.test.mjs
```

Os testes adicionais cobrem PRIMARY15/RESERVE85,25/50/75/100 slots, metas,
reinvestimento, Watchdog ligado à topologia exata e continuidade de sucessor
com transportes em fixture. O último desses é teste de orquestração com máquina
durável simulada; não é um fluxo SQL financeiro completo de successor100.

## Probe de recursos isolado

`tools/testing/slot-workload-resource-probe.mjs` fornece um gerador de programa
ESM para importar somente o transporte público já publicado. O programa não
abre dados privados de filesystem, ambiente, vault, credenciais ou registry;
carrega somente os módulos públicos explicitamente indicados e bloqueia o `fetch`
externo global e simula exclusivamente respostas GET. Uma fila local limita
as execuções pelo `shardedEngineMap` canônico em quatro engines por shard, não
por um limitador artificial de GETs. Os cenários são25+25+25 e100+25+25, com
namespaces distintos e mesma conta fictícia, todos no mesmo Executor03.

As três verificações locais V2 passaram: zero POST/DELETE/rede externa, engine
estrangeiro recusado e75/150observações de TP. A concorrência de ordem é1+1+1
para o baseline25 e4+1+1 para100: pico3 e6 respectivamente. O snapshot inicial
executa os GETs concorrentes reais do transporte e atingiu pico15, relatado
separadamente. Os pesos observados foram1587
(1515privado) e3012 (2940privado), incluindo os dois irmãos. Isso é custo de
transportes fictícios, não consumo Binance real por minuto. O probe retorna
CPU, RSS de processo, bytes JSON, tempo e pico de concorrência para que possa
ser executado em sandbox no hardware do Executor03 sem acesso ao trading.
Resultados deste notebook não são apresentados como medição do VPS.

Além do transporte, V2 usa o `shardedEngineMap` real com cinco callbacks do03
e um do01: quatro03 ficam ocupados, o quinto aguarda vaga e o01 termina antes
da liberação do03. Isso prova o isolamento dos callbacks do scheduler canônico,
não o cron LIVE completo com todas as integrações.

A primeira versão V1 do probe foi executada isoladamente no03 por outro agente:
Node24.21.0,487ms de CPU,111489024bytes de pico RSS e4,895s decorridos, sandbox
sem rede/vault,128MiB/10%CPU, saída0. Esse resultado mede somente transporte
com limitador global4, posteriormente substituído no V2; não deve ser usado
como prova da concorrência4+1+1 nem da fila operacional. A execução remota V2
é evidência separada e deve ser registrada no relatório de fechamento quando
concluída.

A versão V2 foi também executada pelo agente principal no03, Node24.21.0,
no mesmo sandbox sem rede/vault, nobody,128MiB/10%CPU/nice19, saída0.
CPU do programa485,300ms, pico RSS113455104bytes (~108,2MiB), tempo4,893s.
O runtime100+25+25 observou pico6 na fase de ordens e15 no snapshot,
3012weight fictícios totais/2940privados; zero POST/DELETE e foreign engine
recusado. Os callbacks reais atingiram4no03 e1no01; o quinto03 aguardou e o01
terminou antes da liberação do03. Continua sendo TRANSPORT_ONLY, não um
benchmark completo de Vercel/Supabase/cron nem um certificado de weight/minuto.

## Continuidade financeira complementar

`tools/testing/hundred-cycle-continuation.test.mjs`:2/2PASS. Os100fills e100
créditos passam pelo helper canônico de reset e RPC real: successor único com
100slots, predecessorCOMPLETED e replay do mesmo successor. Planners, helper
prepareOrder e SQL prepare/sync reais assentam uma primeiraBUY FILLED com taxa
BNB, umTP NEW e umaNEXT BUY NEW; replay mantém3ordens e1fill sem duplicação.
O cenário75fills/25OPEN preserva exatamente os25TPs, recicla75uma única vez
e prepara/assenta somente1NEXT BUY, deixando74PLANNED e1ARMED.
ACKs são sintéticos: isso não testa envio POST remoto nem latência Production.

## Decisão de certificação

**NÃO APROVADA.** Functional fills, replay, successor, proteção e isolamento
foram exercitados; não existe ainda um upper bound integral por minuto do
fluxo ACTIVE misto com account-global budget, retries e invocações sucessivas.
O inventário conservador revisado de tick pode atingir2980weight total,
portanto não foi registrado como se coubesse em2700/min. Um tick não é um
minuto. Não foi emitido perfilPASS nem criada reserva de capacidade.
O gate100 continua `CAPACITY_UNKNOWN / SLOT_WORKLOAD_UNCERTIFIED`.

## Lacunas que não viram PASS automaticamente

- CPU/RAM e fairness de fila física no Executor03 não são inferidos do PGlite
  local.
- Não foi feito trade, cancelamento, depósito, transferência ou teste artificial
  em Production.
- O teste não persiste uma certificação de capacidade nem remove gate de
  admissão.
- A política de checkpoint, successor e SQL inicial/TP/NEXT estão testados;
  inventário completo de dispatch, account-global budget e envelope temporal
  ACTIVE ainda precisam de evidência para o certificado operacional completo.
- Os 100slots da fixture não comprovam que um engine REAL foi criado.

**NENHUMA OPERAÇÃO LIVE FOI REALIZADA POR ESTE HARNESS.**
