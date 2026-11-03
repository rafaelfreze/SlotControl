# Meta acumulativa por slot — CUMULATIVE_LIFETIME_V1

Decisão expressa do proprietário em 03/11/2026. Substitui a meta de competência
e a prioridade por contador mensal nos motores REAL que adotaram esta política.
SHADOW/Testnet e snapshots históricos continuam com seu significado original.

## Autoridades e cálculo

`robot_v1_live_preparations.slot_goal_policy` mantém a âncora de apuração e a agenda
de metas por competência. A referência inicial é o primeiro BUY com fill reconciliado do
mesmo engine/account, incluindo predecessor runs. Não usar cadastro, deploy,
último reset, mês atual ou número de linhas como início da operação.

No primeiro mês-calendário em America/Campo_Grande, acumula uma meta configurada.
Cada dia 1º acumula mais uma. Com rate constante: rate × meses inclusivos. Com
edições: soma das competências e suas versões, sem multiplicação retroativa do
valor mais recente. SOL2:2/4/6; BTC7:7/14/21. Cada motor conserva sua própria meta.
Início no meio do mês conta como mês1. Resets, migração entre shards e software
novo não zeram isso. A exceção autorizada abaixo exclui setembro de teste.

### Correção de setembro de teste, autorizada em 03/11

Somente engines iniciados em setembro/2026 passam a acumular a partir de
01/10/2026 em America/Campo_Grande. SOL2: outubro2/novembro4/dezembro6;
BTC7: outubro7/novembro14/dezembro21. Cada rate individual permanece igual.
Gains lifetime, inclusive os de setembro, não são zerados ou removidos.
Engines iniciados em outubro ou depois conservam o seu próprio início.

`anchor_at` passa a ser o início da apuração. `execution_anchor_at` preserva a
primeira BUY real e `anchor_correction` aponta para o evento imutável
`SLOT_GOAL_START_CORRECTED`, com políticas completas antes/depois, autorização,
origem real e lease. Relatórios mantêm essa política completa e o evento; os
snapshots passados continuam significando o que significavam na ocasião.
O RPC específico `correct_cumulative_goal_october_start` usa role service,
expected policy/CAS, lock e lease própria breve sem fabricar reconciliação.
Worker ativo, pendência de dispatch/config/fill ou incidente real adia o ajuste,
sem fechar gates. Replay observa o evento; uma resposta perdida nunca autoriza
reenviar ou alterar ordens. Não é uma edição genérica/recorrente de âncora.

A migration `20261103131530_cumulative_goal_october_start.sql` é aditiva e não
reescreve dados automaticamente. O aplicador valida projeto/histórico/RLS/hashes;
a aplicação posterior é individual por run reconciliado. O runtime já entende
a política resultante: só a revisão de metadados muda no mesmo mês, com
PRESERVE_LEVELS e o protocolo existente para qualquer BUY residente. Nenhum
restart de executor ou nova Strategy Engine é necessário.

O escopo do engine herda product/tenant/user do registro `operators`, mantendo
operator/account próprios no motor. A migration corretiva aditiva
`20261103133122_fix_cumulative_goal_operator_scope.sql` fixa essa associação;
fixtures SQL devem reproduzir as colunas reais, sem inventar campos no engine.
O guard também ignora apenas aliases que o próprio PostgreSQL declara gerados
(`attgenerated`), pois BEFORE UPDATE ocorre antes do recálculo deles. Os campos
graváveis de capital continuam comparados integralmente. Correção aditiva:
`20261103134124_fix_cumulative_goal_generated_alias_guard.sql`; regressão com
os três aliases reais reproduz a recusa anterior e comprova rollback integral.

### Exceção Thyely SOLBRL iniciada no fim de outubro

Decisão adicional de 03/11: somente engine `fa551904-15da-4e17-8259-b0a76e206fac`,
conta `5580c011-6ff1-44bd-b568-85932b424ceb`, SOLBRL, mensal3. Apuração inicia
01/11/2026 local, metas novembro3/dezembro6/janeiro9. A BUY de 27/10 e todos
os gains lifetime continuam preservados, inclusive o gain já confirmado.
`THYELY_NOVEMBER_START_V1` e seu evento exato distinguem a autorização da
correção anterior de setembro. Não generalizar essa exceção a novas contas.

Migration `20261103140130_thyely_goal_november_start.sql`, aplicada pelo helper
`tools/operations/apply-thyely-goal-november-start.mjs --verify|--apply` após
ref/schema/histórico/hashes reais. O novo RPC `correct_thyely_goal_november_start`
reutiliza o corpo validado de lease/CAS/auditoria/settlement, mas restringe engine,
conta, par e configuração mensal3 antes de qualquer escrita. O trigger conserva
comparação integral de campos graváveis, aliases gerados e evento/lease próprios.
Sem mudança de runtime, restart, ordens artificiais ou edição dos outros15motores.
O worker atual apenas atualiza sua revisão de meta/rank em PRESERVE_LEVELS.

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

A identidade histórica do slot (REAL:engine:n ou chave legada) não é o UUID da
linha de ledger. Decisões do planner são associadas pelo número físico único
dentro do run integral já validado por ownership. Fixtures devem manter essas
duas identidades distintas, inclusive no refresh do mesmo mês.

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
nulo: o novo worker adota individualmente sob o lease de cada run, depois de
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
