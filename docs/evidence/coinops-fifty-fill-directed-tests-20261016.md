# Thyely — prova financeira isolada de 50 slots

Data: 16/10/2026. Referência recuperada para a evidência inicial: `f82e134084c67b424809c586a3b7b4cd46e00489`. A extensão do pipeline completo usa também as correções de runtime em trabalho nesta entrega; suas saídas novas identificam SHA256 da fonte carregada. Esta evidência não é uma ativação nem um certificado integral de capacidade.

## Configuração exata

- SOLBRL, Executor 03; 50 slots físicos, R$22 por slot, R$1.100 no total.
- Gain 3%, meta mensal 3, spacing normal 2%, pós-ATH 3%.
- Conta/motor/ordens/credenciais são fictícios. Nenhum `.env`, vault, banco remoto ou API Binance real é utilizado.

O factory compartilhado `tools/testing/hundred-fills-reconciliation.test.mjs` agora recebe `slotCount`, `slotCapital`, `normalSpacingRate`, `postAthSpacingRate`, `gainRate` e `monthlyTarget`. O default 100×R$11 e spacing 1%/2% dos testes anteriores permanece. O valor canônico é persistido separadamente em engine, preparation e snapshot do run; não é inferido do número de linhas retornadas. O livro simulado permite trades parciais com IDs imutáveis distintos e inclui `PARTIALLY_FILLED` entre as ordens residentes.

## Resultado direcionado

`node --experimental-strip-types --test tools/testing/fifty-fills-reconciliation.test.mjs`: **7/7 PASS, zero skips**.

1. Cinquenta TPs preenchidos simultaneamente: 100 fills BUY+SELL, 50 créditos mensais e 50 incrementos de gain, mesmo após replay. Principal reinvestido final R$1.132,99975000, incluindo taxa BNB fictícia. Nenhuma criação/cancelamento nesse caminho de observação/assentamento.
2. Crash após sync durável número 17 e após crédito durável número 17: retomada dos restantes, sem fill, gain ou reinvestimento duplicado.
3. Três respostas 503 intermitentes convergem pelo orçamento GET real; a quarta interrompe o agendamento, drena o trabalho em curso e mantém os assentamentos já duráveis. A próxima invocação conclui sem duplicação. Depois da rejeição não há GET ou SQL tardios.
4. Vinte e cinco TPs completos + vinte e cinco parciais: posições remanescentes continuam com TPs próprios residentes. O preenchimento posterior usa novos trade IDs, chega a 50 gains e 125 fills BUY+SELL/parciais, sem trocar identidade de TP.
5. TP cancelado depois de fill parcial não é aceito como proteção: posição residual continua aberta e o checkpoint falha fechado com `COINOPS_LIVE_OPEN_WITHOUT_RESIDENT_TP`. O teste não recria TP por suposição.
6. Checkpoint SQL real: 0→17→50 créditos. Replay sem progresso não renova `observed_at`; `last_reconciled_at` continua nulo até a liberação bem-sucedida completa. O checkpoint mantém a mesma origem/episódio.
7. Lease ativo não é roubado, lease expirado não autoriza sync e somente um dos dois claims concorrentes vence. O planner canônico gera uma decisão `ARM_NEXT_BUY`, não 50 ordens.

O motor fictício de 25 slots no mesmo account/symbol, em outro shard, conserva byte a byte seu ledger de principal em todos esses casos. O transporte recusa adotar a ordem do slot 50 usando a identidade do motor irmão.

## Inventário observado, não certificado

No caso nominal de 50 TPs, somente a fase de reconciliação observada executou:

| Medida | Observado na fixture |
| --- | ---: |
| Round-trips SQL/RPC | 506 |
| Syncs / renovações de lease / ACKs / decisões concluídas | 50 de cada |
| Pico de observações concorrentes | 4 |
| Request weight total / host privado / host público | 1004 / 980 / 24 |

Esse inventário de 1004 é histórico, anterior à observação atômica order+trades.
Na repetição posterior com o novo caminho, a mesma fase de 50 observou
**554 /530 /24**, com os mesmos 506 round-trips e pico 4. A fase de 100 observou
1108/1060/48 no modelo de latência de 150ms, que inclui um refresh da cotação
quando seu TTL de 60s expira. Não converter esses números de fase em perfil
integral de 50 ou 100.

As chamadas são do transporte VPS real com fetch simulado, helper web real, ACK/registry/decisão reais e corpos SQL versionados em PGlite. Pesos são inventário dos endpoints, não consumo Production. O relógio lógico de 150ms serve para testar TTL; não representa a latência distribuída real.

## Compatibilidade e validação

- Execução conjunta anterior à inclusão explícita da meta 3 no fixture: 19/19 PASS (7 novos de 50 + 12 existentes de 100).
- Após persistir a meta 3: 7/7 de 50 PASS; após a separação do custo da assert de configuração, o caso nominal foi repetido: 1/1 PASS.
- `node --check` dos dois arquivos e `git diff --check` direcionado: PASS.
- A suite de 100 permanece com defaults retrocompatíveis; não se converte uma prova de 100 em certificação de 50 por proporcionalidade.

## Extensão: pipeline completo e contraexemplos de capacidade

Os arquivos `tools/testing/variable-engine-full-advance-fixture.mjs` e
`variable-engine-full-advance.test.mjs` passam a executar o módulo inteiro de
`advanceLiveRun`, incluindo o coordenador de continuidade. Não há uma segunda
Strategy Engine no harness. Todas as dependências web são compiladas do código
canônico; somente o provider Supabase é substituído por consultas/RPCs PGlite e
o ambiente/fetch são isolados. O handler VPS, assinatura HMAC, registro,
permissões, health, cofre com credencial fictícia, transporte Binance, budget,
decisões, ATH, ledger, gains, lease, reset e preparação são os caminhos oficiais.

O scaffold não certifica Auth/RLS remoto nem saldo/filtros reais da Binance.
Nenhuma leitura de `.env`, vault operacional ou conexão externa é feita. Os
arquivos temporários da credencial fictícia ficam em uma pasta nova e delimitada
de `tools/testing`, removida ao terminar. Toda consulta financeira usa os corpos
SQL versionados, inclusive os binders canônicos de ownership e identidade física.

Provas já executadas individualmente no pipeline completo:

- Topologias 25/50/100 com TPs residentes e zero POST/DELETE: PASS. Isso é
  regressão de leitura, não certificação financeira de 100 slots.
- Cinquenta TPs preenchidos, 50 créditos exatamente uma vez, successor único,
  MARKET protegido e uma NEXT BUY residente: PASS, por fases persistentes.
- Interrupção abrupta simulada após sync 17 e após crédito 17: PASS. O provider
  do worker antigo é cercado e sua chamada permanece suspensa, sem entrar no
  catch/finally; outro módulo real retoma o mesmo banco e as mesmas evidências
  do executor após expirar somente a lease da fixture. Não é um kill de processo
  real nem uma resposta ambígua de escrita Binance.
- Quarta falha GET distinta: retorna o checkpoint transitório tipado, drena os
  workers e converge no fluxo normal seguinte, sem gain/ordem duplicados: PASS.
- Dois irmãos de 25 slots executando integralmente no mesmo account/symbol/shard,
  com 25 TPs preenchidos em cada um: isolamento financeiro PASS (25+25 gains,
  dois successors únicos, TP e NEXT próprias). O transporte simulado não impõe
  a quota de peso; portanto o PASS financeiro não é PASS de capacidade.

Essa última prova encontrou **8515 weight total em 20,5s**, sendo 1442 atribuídos
ao motor de 50 e 3414/3659 aos irmãos de 25. Privado e público foram somados
conservadoramente. Isso refuta o modelo de certificação agregado para esse trace,
apesar de todos os ledgers terem convergido. Não prova violação factual da quota
Binance: os hosts podem ter orçamentos distintos e o rate limit real não foi
ensaiado. O host privado sozinho consumiu 5707 nesse intervalo, acima do envelope
ordinário 3900 e sem a reserva exigida para recuperação.

Uma variante **somente offline**, rotulada `EXPERIMENTAL_FEE_QUOTE_25_REUSE`,
compartilha apenas a cotação BNB por até 60s na fase de observação dos irmãos de
25. Ela conserva a fila serial, o transporte legado order+trades, os snapshots
financeiros pré-POST, a leitura extra de crédito e a estratégia. O mesmo caso
passou financeiramente com **5462 weight** (1197/2010/2255 por motor). Há economia
estrutural de 25 snapshots de 54 por irmão; variação de coalescência/janelas do
budget explica parte da diferença entre traces. Não é uma edição Production,
nem comprova headroom para retries ou para os demais motores.

O cenário extremo de uma BUY antiga PREPARED, TPs parciais, dois novos fills de
BUY, cancelamentos seguros, permission503, clock -1021, três retries externos e
quatro mercados nativos é exercitado por completo. Antes dos novos boundaries,
um trace financeiro válido consumiu 3352 weight em uma invocação (contador
histórico, anterior à correção do weight DELETE de 4 para 1). Após o boundary
BUY→TP protegido, a entrada seguinte fica para outra lease. Foram necessárias
três fases e cinco POSTs no conjunto: BUY1+TP1, BUY2+TP2 e a NEXT BUY finalmente
residente. Os cancelamentos não são repetidos e os 24 gains históricos são únicos.

O novo checkpoint revelou que `trades_reconciled=false` em PARTIALLY_FILLED é
semântica terminal canônica, não prova de fill perdido. A migration
`20261016193756_prove_partial_tp_reconciliation_checkpoint.sql` é carregada no
banco descartável para provar soma/identidade/fees/resíduo dos fills parciais,
sem promover o flag terminal nem autorizar uma BUY. Um TP ausente continua falha
fechada. O harness não aplica migrations remotas.

O trace final sem filtro global, com os faults acima e duas janelas reais de
counter expiradas, observou **2807/2252/1572** por fase com weight DELETE=1.
Uma execução anterior ao ajuste do contador tinha 2810/2255/1572. Isso não
constitui um limite universal: os três retries desse
trace são de ordem, não os endpoints mais caros, e reexecuções imediatas podem
aproveitar cache de budget/health. Uma prova adicional usa a cadência real de
60s e filtro global de ordens. Não inferir rolling60s do valor por invocação.

### Cadência natural e separação por host

A execução natural inicial terminou em 134,179s, com três inícios separados
por 60s. Cada passagem consumiu 3134/3084/2404. O pico conservador rolling60s
foi 4933 e o minuto alinhado máximo 4552. Os picos por host não foram registrados
nesse primeiro trace e não são inferidos a partir dos totais.

Uma repetição com contadores específicos por host terminou em 181,091s. A primeira
passagem retornou `COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN` após duas observações
completas expiradas, **zero POST/DELETE**. O limite de 35s foi respeitado; não se
forçou uma terceira leitura fora do orçamento. Os próximos inícios normais
retomaram o mesmo run e concluíram as fases. Resultado funcional: PASS.

| Métrica no segundo trace | API privado | Público | Soma conservadora |
| --- | ---: | ---: | ---: |
| Peso total do episódio de 181,091s | 6797 | 1640 | 8437 |
| Maior rolling60s | 3189 | 956 | 4145 |
| Maior minuto alinhado pelo relógio do provider simulado | 2080 | 622 | 2702 |

As quatro passagens consumiram 1666/2047/2702/2022 no agregado; a primeira foi
o HOLD, não uma operação financeira concluída. Foram cinco POSTs e dois DELETEs
no episódio, 24 gains exatos, TPs dos resíduos protegidos e uma NEXT BUY final.
O alerta de budget foi encerrado apenas pelo resolver canônico após comprovar
ordem, decisão e ACK/reserva; não há remoção manual de alerta.

O API privado desse trace **não** ultrapassou 3900 nem comprova violação da quota
oficial de 6000. O agregado é um modelo de certificação conservador, não uma
afirmação de quota compartilhada entre hosts. O episódio total também não é
consumo por minuto. A certificação de 50 permanece **FAIL / NÃO EMITIDA**: os
traces não fornecem o bound universal requerido, a projeção canônica quantizada
precisa de headroom real, e o burst da fleet já mostra API privado sem a reserva
operacional exigida. Não há autorização de ativação derivada desses resultados.

Identidade do código testado: `robot-v1-live-server.ts` SHA256
`0118d82cc6947646a04e7012c91ece4a9a6619d027e94ab845419d256789abc3`.
Manifesto financeiro congelado verificado:
`42bddbc53c9c21b19c33e594dd85275234aacfb78a2e04016ec8586e8bf49c4e`, 108 arquivos.

### Validação final executada

- Kernel financeiro de 50 e 100 com o transporte novo: **19/19 PASS**, 127,889s.
- Pipeline completo: 16 casos executados, **15 PASS e uma expectativa de OK
  imediato incorreta** na variante offline de 25. A resposta foi HOLD budget,
  não uma exceção financeira. O teste foi corrigido para esperar o cooldown real,
  retomar o mesmo successor e exigir TP/NEXT finais; sua repetição direcionada
  passou **1/1** em 45,773s, sem fingir uma nova execução integral da suíte.
  Houve HOLD em um dos irmãos; a retomada real após cooldown concluiu oito POSTs
  totais, 50 gains dos irmãos, TP e NEXT próprios, sem apagar alertas. Essa
  variante offline consumiu 5646=4110 API+1536 público em 38,356s e também não
  satisfaz o envelope ordinário; não foi aplicada em produção.
- Cadência global com contadores por host: **1/1 PASS**, 187,531s incluindo setup.
- `node --check` dos novos arquivos, `git diff --check` do escopo e verificação
  do manifesto financeiro: PASS.
- Nenhum teste, fixture, variante ou resultado emite certificado de capacidade,
  publica migration remota, aciona Watchdog ou envia ordem Binance LIVE.

As contagens agregadas/por host acima não dependem de atribuição visual. Na
última repetição da variante offline, a chamada explícita ao successor de um
irmão foi inicialmente rotulada como engine principal pelo contador auxiliar
(1071 da primeira chamada +1123 da retomada pertencem ao mesmo irmão). O ledger,
as ordens e os gates sempre usaram o engine correto, e o total 5646 não mudou.
O contador agora resolve o engine do successor pelo registro persistido antes
de atribuir requests; essa correção não altera execução, SQL financeiro ou peso.

Comandos reproduzíveis são os próprios testes Node, com `--experimental-strip-types`,
`--test`, `--test-force-exit` e seleção por nome para os casos extensos. As saídas
incluem requests por endpoint/host, pesos por engine/invocação, janelas alinhadas
e rolling60s, SQL/RPC, POST/DELETE e os códigos 409 originais. Novas execuções
também registram SHA256 do `robot-v1-live-server.ts` efetivamente carregado.
Pesos de DELETE: [Binance Spot Trade](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/trade).

## Limites explícitos

- O cenário de fill/cancel observa um cancelamento parcial confirmado e prova o bloqueio por ausência de proteção. Não é uma execução real de cancelamento concorrente na Binance.
- Os sete testes de kernel iniciais não executam o `advanceLiveRunOnce` inteiro. A extensão descrita acima executa o pipeline completo, mas não transforma traces em um limite universal de frequência/custo. A continuidade SQL/planners e o inventário de componentes de `fifty-slot-workload.test.mjs` continuam evidências separadas.
- PGlite prova os corpos financeiros e o comportamento de replay; não substitui teste de contenção PostgreSQL multissessão, runtime físico ou validação remota de RLS.
- A existência de 50 linhas na fixture não comprova um motor REAL criado, Admission PASS, saldo Binance, whitelist ou TP/NEXT BUY LIVE.
- Não foi alterado código operacional, migration, cron, política de segurança ou parâmetro de motor existente por este subtrabalho.

**NENHUMA OPERAÇÃO LIVE REALIZADA POR ESTES TESTES.**
