# CoinOps LIVE BRL — operação e segurança

Escopo: BTCBRL e SOLBRL, Binance Spot Production, projeto Supabase
`otdfpmsegjxpqrzisfmi`, schema `coinops`, executor de IPv4 fixo
`46.101.104.48`. Esta documentação não autoriza outros pares, saque,
transferência, margem ou Futures.

## Fonte de verdade e limites

- GitHub `main` é a fonte de código. O ledger `coinops.robot_v1_live_*` é a
  fonte transacional de ciclos, 25 slots físicos, intenções, ordens, fills,
  saldos, eventos e alertas. A Binance é consultada por ID próprio antes de
  qualquer POST; o ledger nunca deduz fill de uma resposta sem trades.
- Hard caps: R$ 450 BTC, R$ 275 SOL e R$ 725 global. A configuração LIVE
  atualmente preparada usa R$ 450 BTC e R$ 275 SOL, distribuídos em 25 slots
  por ativo. O saldo restante da conta Binance não aumenta esses limites.
- Uma BUY ativa por ativo; posição OPEN precisa de TP residente. Apenas a
  próxima BUY é ordem residente; os demais níveis ficam PLANNED. A Strategy
  Engine compartilhada determina prioridade, regime ATH, rank e metas.
- A migration `20260924041046_add_robot_v1_live_execution_ledger.sql` é aditiva
  e, sozinha, não ativa LIVE nem envia ordens. Scripts SQL financeiros devem
  ser testados somente em PostgreSQL efêmero/local.

## Portões de ativação

1. Confirmar backend/schema, migration, RLS, cap e flags `live_enabled=false`,
   `kill_switch=true`; nenhum ciclo ou ordem LIVE anterior deve ser presumido
   ausente sem consulta atual.
2. Executor do IPv4 fixo com `TRADING_ENABLED=false`, `KILL_SWITCH=ON`, saúde
   verificada e versão alinhada à Vercel. Confirmar permissões restritas Spot,
   sem saques/transferências/margem/Futures. Testar somente `/api/v3/order/test`.
3. Preparar os ciclos por ativo na rota autenticada
   `POST /api/coinops-live-activation` (`PREPARE`) ou no controle operacional
   `POST /api/cron/live-control` com `COINOPS_LIVE_CONTROL_SECRET` exclusivo
   de Production, ainda sem ordem. Confirmar
   25 slots, capital lógico e ausência de ordens próprias na Binance.
4. Publicar o executor com `TRADING_ENABLED=true`, `KILL_SWITCH=ON` para manter
   proteção de posições sem novas BUYs; só após todas as provas, liberar
   `KILL_SWITCH=OFF` e ativar cada ciclo (`ACTIVATE`). Cron LIVE deve estar
   habilitado explicitamente. Ativar BTC e reconciliar MARKET, fill, TP e
   próxima BUY antes de ativar SOL.
5. Confirmar diretamente Binance e ledger para ambos: IDs CoinOps,
   quantidades, TP, única próxima BUY, 23 planejados, exposição, saldo e
   ausência de duplicações. Inspecionar UI, CSV `LIVE_EXECUTION`, logs e
   alertas. Não usar ordens manuais como smoke.

A reconciliação histórica Shadow versus Binance Production continua somente
GET, mas suas consultas assinadas agora passam pelo executor de IPv4 fixo. A
chave antiga presente na Vercel não é usada para esse cron depois da whitelist.
O controle operacional não aceita usuário, preço, quantidade ou ordem do
chamador: resolve o único proprietário CoinOps preparado e recusa escopo
ambíguo. `ACTIVATE` apenas libera o ciclo no ledger após novo snapshot da
Binance; as ordens seguem exclusivamente pelo cron normal.

## Recuperação e monitoramento

- O cron de execução roda a cada minuto e reconcilia antes de agir. O cron
  `/api/cron/live-monitor` roda a cada seis horas, independente deste chat.
  Ele verifica executor, ordens próprias abertas, OPEN↔TP, 25 slots, saldos,
  hard caps, reconciliação recente e erros; achado crítico registra alerta e
  liga `kill_switch` no banco para bloquear novas BUYs.
- Após timeout ou resultado incerto de POST, consultar o mesmo clientOrderId
  e a Binance antes de qualquer nova intenção. Nunca repetir com outro ID,
  cancelar ordens não próprias ou creditar lucro sem fill provado. Resultado
  ainda ambíguo permanece fail-closed.
- Uma leitura `/v1/state` com resposta transitória inválida é repetida no
  máximo uma vez; nenhuma ordem é repetida por esse mecanismo. Falha
  persistente ou em outra etapa mantém o bloqueio BTC/SOL correspondente e
  registra a etapa da reconciliação no código do alerta. Uma BUY que já era
  residente pode preencher enquanto o kill switch SQL está ligado: reconciliar
  esse fill, preservar/criar seu TP e verificar o estado real antes de retomar
  a única próxima BUY.
- Reinício breve do executor pode interromper uma leitura em andamento. As
  consultas de estado, ordem e trades repetem somente erros transitórios de
  rede/502/503/504, com espera limitada; POST de create/cancel não é repetido.
  Falha persistente continua fail-closed e requer prova Binance + ledger.
- Em incidente, `KILL_SWITCH=ON` no executor e no preparo SQL bloqueia novas
  BUYs. Não apagar o ledger. Ordens de proteção SELL podem continuar sob
  `TRADING_ENABLED=true`; cancelamento protetivo só admite BUY própria com ID
  e orderId exatos. Revisar posições e TPs antes de retomar.
- Para retomar um ciclo já `ACTIVE` após falha transitória, manter o kill switch
  SQL ligado até o cron voltar a reconciliar sem erro. Desligar o kill switch do
  executor somente após conferir as ordens próprias na Binance; então usar
  `RESUME` no controle operacional autenticado. A rota exige versão e saúde do
  executor, ledger de 25 slots, correspondência exata com ordens abertas,
  OPEN coberto por TP, fills reconciliados e exposição dentro dos hard caps.
  Se qualquer verificação falhar, novas BUYs permanecem bloqueadas.
- Após o último fill de um ciclo, `COINOPS_LIVE_RESET_FAILED` exige confronto
  Binance/ledger antes de qualquer nova MARKET. A transição ledger-only pode
  concluir o ciclo antigo e criar um sucessor único de 25 slots mesmo com o
  gate de BUY fechado; isso não envia ordens. Verificar `previous_run_id`,
  ausência de posição/ordem antiga, fills reconciliados, 25 contas físicas e
  sucessor único. O sucessor deve reconciliar sob kill switch antes do RESUME
  autenticado. Após RESUME, o cron inicia a MARKET somente se a Strategy Engine
  ainda determinar entrada, cria TP e uma próxima BUY. O alerta anterior só
  é encerrado após posição protegida, uma BUY residente e reconciliação.
  Para um sucessor `ACTIVE` porém protegido, a Central de Estratégia mostra
  `Retomar`; a rota autenticada permite essa recuperação apenas com kill switch
  do motor ligado e reaplica todos os gates de `resumeLiveRun`. O cadastro
  legado Rafael é resolvido como REAL pelo servidor, sem credencial nova.
- A visão Real de `/automacao` não consulta histórico Shadow/Testnet pausado no
  carregamento. Abrir as abas correspondentes faz suas leituras históricas;
  timeout de consulta nelas não deve derrubar a visão LIVE.
