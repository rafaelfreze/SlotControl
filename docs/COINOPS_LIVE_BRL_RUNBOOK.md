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
- Hard caps: R$ 450 BTC, R$ 275 SOL e R$ 725 global. A configuração inicial
  preparada usa R$ 447 BTC e R$ 269,75 SOL, total R$ 716,75. O saldo restante
  da conta Binance não aumenta automaticamente esses limites.
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
   `POST /api/coinops-live-activation` (`PREPARE`), ainda sem ordem. Confirmar
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
- Em incidente, `KILL_SWITCH=ON` no executor e no preparo SQL bloqueia novas
  BUYs. Não apagar o ledger. Ordens de proteção SELL podem continuar sob
  `TRADING_ENABLED=true`; cancelamento protetivo só admite BUY própria com ID
  e orderId exatos. Revisar posições e TPs antes de retomar.
