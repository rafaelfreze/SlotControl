# Prioridade mensal e atribuição prospectiva de níveis — 26/10/2026

Produto CoinOps, Supabase OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`,
REAL. Autorização específica: comando do proprietário “CORREÇÃO DA PRIORIDADE REAL
POR GAINS MENSAIS”, substituindo a política descrita na auditoria anterior.

## Contrato MONTHLY_GAINS_V1

- Primeiro slots disponíveis abaixo da meta, por gains do mês DESC em
  America/Campo_Grande. Lifetime DESC e número físico ASC desempatarão.
- Esclarecimento posterior confirmado: meta individual alcançada retira o slot
  de novas compras até o dia 1º. Demais slots continuam; OPEN/TP é preservado.
  Única exceção: N/N slots físicos com meta comprovada libera todos novamente
  no mesmo mês, sem zerar gains. N-1 completos e um OPEN ainda abaixo não libera.
  OPEN/partial/MISSED e evidência financeira incompleta não recebem nova entrada.
- Preservar fronteiras PRIMARY/RESERVE do ciclo e a exceção canônica de reentrada.
  No próximo planejamento ATH, os grupos mantêm até 15 PRIMARY e o restante
  RESERVE, excluindo metas individualmente concluídas até a exceção N/N; prioridade mensal dentro
  do conjunto permitido. Não renumerar slots ou mudar spacing/gain/meta/capital.
- Níveis válidos ainda não comprometidos são um pool, separado de capital e
  identidade. Atribuir preços DESC à prioridade mensal; não ancorar no ticker,
  inventar níveis, movimentar saldo, copiar ganhos nem reescrever operações.
- Política de entrada possui versão própria. O protocolo de execução 4.3.1 não
  é alterado: decisões/ordens antigas continuam reconciliáveis; novos contextos
  REAL e snapshots de alocação identificam MONTHLY_GAINS_V1. Relatório v31.

## Aplicação financeira

O worker normal reconcilia fills e protege TODOS os TPs antes de considerar BUY.
`allocateMonthlyEntryLevels` é planejamento puro na Strategy Engine. Se a BUY
atual não corresponder ao dono desejado, provar ordem própria NEW, execução zero,
suporte ONLY_NEW, saldo/caps/filtros/BNB do novo dono e lease válida; registrar
intenção e usar `cancelOwnedEntry`. Fill concorrente vence. Timeout exige leitura
do mesmo client/order; ausência não é cancelamento. Nenhuma ordem adicional de teste.

Depois do cancelamento vazio confirmado, o RPC
`coinops.allocate_live_monthly_entry_levels` bloqueia o run e slots, valida o
snapshot completo 1..N, mês e ledger de gains exatos, escopo e lease, ausência de
execução/ordem ativa nos slots que mudam e a permutação do pool. Atualiza somente
preços/referências prospectivos e rank PLANNED, mais checkpoint/auditoria.
RLS existente intacta, SECURITY INVOKER, EXECUTE exclusivamente service_role,
search_path vazio. Não toca contas/capital/OPEN/TP/fills/gains/strategy config.

Cada nível carrega `sourceId/sourceOrigin`: o RPC comprova origem na mesma
permutação; `entry_price_sources` conserva a prova por slot. A nova ordem congela
essa prova no config_snapshot. A validação de preço continua exigindo tick,
referência, identidade run/engine/slot e a geometria original de GRID; níveis de
reentrada são reconhecidos somente pela origem comprovada. Nunca usar um boolean
do caller como autorização para preço arbitrário.

O checkpoint e evento são atômicos. Crash antes do commit não troca preços;
crash depois dele retoma do checkpoint, sem repetir cancelamento ou transferir
capital. Resposta RPC incerta usa readback de plan_id e dos preços/ranks atuais.
Uma única continuação passa novamente pelos guards oficiais antes de criar BUY.
Reexecução sem mudança de alocação/rank não escreve nem gera flapping. A alteração
natural de gains, meta, regime ou mês produz nova decisão prospectiva.

## UI, auditoria e testes

Rank desejado é distinto da ordem Binance confirmada. PRÓXIMA BUY continua
derivada da ordem residente. Valores planejados são rotulados sem execução;
mensagem explica prioridade mensal, meta, grupos e reconciliação pendente.
Histórico anterior sem marcador permanece LEGACY_PRICE_FIRST nos exports.

Fixtures do planner cobrem 4/7,3/7,2/7,1/7 com preços trocados, novo gain,
empates, calendário/ano, todos com meta, OPEN/MISSED/partial, BTC/SOL,25/50/100,
regimes e isolamento. Harness do worker cobre cancel/fill/partial,503/timeout,
crash após alocação, readback incerto, proveniência e preservação OPEN/TP/capital.
PGlite descartável executa a migration real: permutação atômica, replay, lease,
escopo, snapshot parcial/stale, OPEN/ordem ativa, origem forjada e rollback.
Teste SQL nunca usa o projeto vinculado. Capacidade de N>25 não é certificada
por estes testes e nenhum motor adicional está autorizado.

Publicação requer fingerprint financeiro atualizado, migration aditiva conferida,
GitHub/main, deploy web e rollout sequencial da release comum de executores,
pois preparation.mjs importa a Strategy Engine. Somente FLEET_PARITY_PASS fecha
runtime. Validar ordens reais e ledger pelo observador read-only, nunca por trade
artificial. Falha de um motor não autoriza kill switch global ou limpeza de gates.

Validação local final: 118 testes do núcleo/harness, 66 de relatórios e 5 SQL
descartáveis PASS (189 no total); lint e typecheck PASS; build isolado PASS,
sem credenciais de produção e com o ambiente local original restaurado. A
primeira tentativa de build encontrou EPERM na pasta gerada; a repetição isolada
com permissão local concluiu. Warnings já existentes de Supabase/Edge e CSS.
Resultados de Production e paridade devem ser confirmados após o deploy; estes
testes não afirmam que uma ordem real foi criada nem certificam admissão N>25.
