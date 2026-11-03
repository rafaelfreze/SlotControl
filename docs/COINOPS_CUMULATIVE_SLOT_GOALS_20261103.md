# Meta acumulativa por slot — CUMULATIVE_LIFETIME_V1

Decisão expressa do proprietário em 03/11/2026. Substitui a meta de competência
e a prioridade por contador mensal nos motores REAL que adotaram esta política.
SHADOW/Testnet e snapshots históricos continuam com seu significado original.

## Autoridades e cálculo

`robot_v1_live_preparations.slot_goal_policy` mantém a âncora imutável e a agenda
de metas por competência. A âncora é o primeiro BUY com fill reconciliado do
mesmo engine/account, incluindo predecessor runs. Não usar cadastro, deploy,
último reset, mês atual ou número de linhas como início da operação.

No primeiro mês-calendário em America/Campo_Grande, acumula uma meta configurada.
Cada dia 1º acumula mais uma. Com rate constante: rate × meses inclusivos. Com
edições: soma das competências e suas versões, sem multiplicação retroativa do
valor mais recente. SOL2:2/4/6; BTC7:7/14/21. Cada motor conserva sua própria meta.
Início no meio do mês conta como mês1. Uma operação que começou em setembro está
no mês3 em novembro; resets, migração entre shards e software novo não zeram isso.

Lifetime vem de `robot_v1_slot_gain_totals`, lastreado em créditos imutáveis,
com separação de origem mercado/manual. Não sintetizar ganhos a partir de preço,
P&L ou contadores de apresentação. Uma evidência incompleta continua fechada.

## Elegibilidade e prioridade

O helper canônico `rankMonthlySlots` recebe o contexto acumulativo persistido.
Prioriza lifetime DESC e físico ASC entre elegíveis abaixo da meta. Os gains
do mês permanecem dados informativos, sem substituir lifetime nessa decisão.

Estados disponíveis para entrada são PLANNED/ARMED com zero posição ou CLOSED
settled pelo fluxo normal. OPEN, partial, MISSED histórico, bloqueio e falta de
prova não recebem uma segunda entrada. Existe exceção somente quando o conjunto
físico está íntegro e TODOS os disponíveis atingiram a meta: esses disponíveis
voltam à fila, sem zerar lifetime. OPEN abaixo da meta não causa deadlock.
Gates financeiros, meta da própria operação e autorização MISSED explícita
continuam independentes. Um partial residente permanece pinado e reconciliado.

PRIMARY conserva até15 elegíveis; demais RESERVE. Seleção de grupo e exceção de
reentrada permanecem. Um reset integral comprovado cria novas oportunidades
lógicas, recalcula elegibilidade e preserva o histórico MISSED no predecessor.
Não reseta a âncora ou os créditos do engine.

## Ordens e snapshots

Adotar a política ou virar competência atualiza apenas metadados, ranks e grupos
pela transição PRESERVE_LEVELS. Não reancorar preços no ticker. A atribuição futura
é uma permutação do pool comprovado, na Strategy Engine existente. O identificador
histórico MONTHLY_GAINS_V1 continua no protocolo dessa alocação; a base econômica
é explicitada por `slot_goal_state.policy=CUMULATIVE_LIFETIME_V1` e por goal_policy
no checkpoint SQL. Não reinterpretar snapshots anteriores sem esse marcador.

Uma NEXT BUY por engine. A substituição passa pelo fluxo oficial ONLY_NEW,
ownership exato, lease, zero fill reconciliado, fill-wins e CAS atômico. Resposta
ambígua exige leitura. OPEN/TP, saldos, principal+reinvestimento, gain, spacing,
ATH, IDs e créditos financeiros não são editados pela adoção. Não testar com trades.

## Edição prospectiva

O Bulk Editor continua a única edição oficial. `monthly_target` mantém o valor
configurado; o trigger acrescenta a versão efetiva na próxima competência.
Competências vencidas e âncora são imutáveis. Outra edição antes da vigência
substitui somente a versão futura ainda não efetiva; todos os pedidos/versionamentos
anteriores permanecem na auditoria oficial do Bulk Editor. Retry sem mudança de
valor não acrescenta outra competência. Gain/spacing/metas de outros motores não
mudam. UI mostra lifetime/meta acumulada, mês do ciclo, próxima meta e gains do mês.

## Schema, rollout e recuperação

Migration aditiva `20261103110000_cumulative_slot_goals.sql`, somente CoinOps,
ref otdfpmsegjxpqrzisfmi/schema coinops. Não aplicar migrations de outros produtos.
RLS existente permanece. Funções novas de adoção e elegibilidade são service_role,
search_path vazio. Guards financeiros antigos são preservados. A alocação reutiliza
seu snapshot CAS para o cálculo, sem N consultas adicionais por slot.

Aplicador `tools/operations/apply-cumulative-goal-migration.mjs --verify|--apply`
confere projeto, histórico, RLS e hashes das três funções remotas antes de escrever.
Sem replay de migration ou sobrescrita de drift. A migration deixa o novo campo
nulo: o novo worker adota sequencialmente sob o lease de cada run, depois de
reconciliar e proteger TPs. A primeira BUY reconciliada ancora um motor novo;
não financiar/iniciar automaticamente outro motor. O RPC de adoção é idempotente
com evento imutável. Resposta perdida é observada antes de continuar; readback
nulo após falha transitória tipada aguarda outro tick. Ambiguidade permanece local.

Publicar main, fixar manifest de runtime em segundo commit e rollout sequencial.
Promover ambos VALIDATED_VERSION/NEXT_VALIDATED_VERSION da web e validar a frota,
Admission, Watchdog, fontes server-side, Binance×ledger e UI autenticada. Rollback
de código depois da adoção exige release compatível com a política; não apagar o
campo nem rebaixar para política mensal em motor já adotado.

## Evidências e testes

Diagnóstico privado local: `docs/evidence/coinops-cumulative-goal-20261103-*`.
Inclui âncora/progresso por motor; não publicar dataset financeiro em Git.
Testes: cumulative-slot-goal, monthly-slot-read, monthly-level-preservation,
slot-priority-contract, premium-model, alocação SQL, preparação MARKET/partial,
ownership cross-shard, ONLY_NEW/fill concorrente, limites Binance, idempotência
e transporte simulado. Banco PGlite descartável; nenhum teste usa Supabase LIVE.
