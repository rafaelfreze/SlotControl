# CoinOps 5.1 — preparação LIVE em BRL, sem ordens reais

BTCBRL e SOLBRL são **preparação**. A única fonte operacional futura do Real é BRL; preços USD/USDC de Shadow/Testnet não são convertidos silenciosamente em capital, lucro ou gain Real. Binance Production usa exclusivamente GET. `createOrder` e `cancelOrder` do adaptador Production lançam `LiveExecutionBlockedError`. A configuração Real persiste `live_enabled=false` e `kill_switch=true` por constraints. Salvar capital ou percentuais não muda esses estados.

## Escopo e configuração inicial

Backend oficial: OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`, um owner/scope de CoinOps confirmado na preparação. A migration `20260924001657_add_robot_v1_live_brl_preparation.sql` acrescenta configuração Real e hard caps isolados, tabela global de limite, ledger preparado BRL de 25 slots/ativo (saldo zero) e eventos de edição. Shadow e Testnet continuam em BTCUSDC/SOLUSDC com 0,5%/1%. Nenhum ciclo, ordem, posição ou operação real é criado.

Configuração Real inicial: BTCBRL 25 slots, gain 1,2%, spacing normal 1%, pós-ATH conforme perfil existente, meta 7/slot/mês; SOLBRL 25 slots, gain 5,5%, spacing normal 1,5%, pós-ATH conforme perfil existente, meta 2/slot/mês. Compounding, Single Active Entry, initial MARKET e reentrada local são sinalizados como regras de preparação. O formulário ATH existente edita os percentuais para o próximo ciclo, sem ativação LIVE. Os formulários de capital editam somente o orçamento CoinOps e os hard caps.

Valores iniciais de cap derivados do snapshot público Binance de 23/09/2026 23:46 UTC: BTC R$ 17,88 por ordem, R$ 447,00 capital/exposição de 25 slots; SOL R$ 10,79 por ordem, R$ 269,75 capital/exposição; limite global R$ 716,75. São valores iniciais versionados, **não garantia de ordem futura**. O gate recalcula filtros e preços em toda visualização/exportação; se ficarem insuficientes, bloqueia. Saldo físico BRL livre da Binance é consultado separadamente por GET assinado.

## Cálculo e preview

`exchangeInfo` e `ticker/price` públicos fornecem status, pares, tick, lote LIMIT, lote MARKET, notional, precisão, tipos de ordem e permissão `quoteOrderQty`. O dimensionamento testa os 25 níveis usando o mesmo `planAthLadder` e as decisões puras `planStrategyInitialEntry`, `planStrategyTakeProfit` e `planStrategyNextEntry`/`planStrategyPostAthNextEntry`. Para cada nível, procura a menor quantidade discreta que cumpre mínimo de compra e mínimo do TP depois de reservar 0,2% de fee em base. O maior mínimo da escada recebe mais 0,2% de fee em quote e 2% de margem de preço/arredondamento, com teto de centavo. Fee específica da conta não foi comprovada; 0,2% é hipótese conservadora, não tarifa certificada. `PERCENT_PRICE_BY_SIDE`, volatilidade, liquidez e preço médio usado por MARKET devem ser revalidados em uma fase de execução separada.

O preview de 25 slots mostra identidade física, rank, grupo Top15/Reserve quando POST_ATH, entrada, quantidade estimada, TP e elegibilidade. A posição inicial, TP e próxima BUY são apenas decisões `NO_WRITE`; o mesmo núcleo também ensaia reentrada local após +R$ 5 hipotéticos no próximo saldo, bloqueio por meta mensal e reset global. `OPEN=0`, sem ledger financeiro ou ordens reais. Preço/filtros com mais de 120 segundos, par não-TRADING, cap incorreto ou prova ausente bloqueiam o gate.

`LIVE_PREPARATION_READY` significa apenas preparação técnica suficiente no snapshot atual; `BRL_INSUFFICIENT` distingue o caso de saldo livre abaixo do capital CoinOps. `BALANCE_UNKNOWN` e `BLOCKED` são fail-closed. Nenhum estado muda permissões da Binance ou remove o kill switch.

## Fronteira contábil e legado

O ledger BRL preparado nasce com 50 contas de saldo zero, sem market P&L, gain manual, aporte ou fee. O ledger Real-USDC criado na Fase 4.4 não continha ajustes nem contas com saldo na inspeção pré-migration. Sua rota de escrita é bloqueada nesta fase, inclusive por trigger no banco, para impedir que um aporte/gain Real em BRL seja convertido para USDC e tratado como capital LIVE. Ganho manual/aporte Real em BRL **não é habilitado** por esta preparação; exigirá fluxo transacional BRL próprio em fase separada, com preview, idempotência, estorno e auditoria. Shadow/Testnet mantêm os fluxos existentes.

## Segurança, rede e observabilidade

Sem evidência de Static IP habilitado no projeto Vercel, não se deve presumir IP fixo para whitelist Binance. A [documentação oficial da Vercel](https://vercel.com/kb/guide/how-to-allowlist-deployment-ip-address) informa saída dinâmica por padrão e Static IPs/Secure Compute como opções. Nenhuma infraestrutura ou permissão é alterada nesta fase.

O pacote de relatórios v8 inclui `LIVE_PREPARATION.csv`, fonte de configuração versionada/RLS, snapshot GET atual, filtros, capital, BRL disponível, limites, versão da Strategy Engine, status dry-run, ledger BRL e gate. Snapshot atual não reconstitui filtros/saldo históricos; fonte indisponível vira WARNING/valor vazio. `AUDITORIA_COMPLETA.json`, manifest e checks acompanham o CSV.

Antes de uma futura ativação, uma fase separada terá de revalidar filtros/preço/fee/liquidez, definir conectividade/IP, implementar executor e ledger BRL transacional e obter autorização explícita para alterar permissão Spot e para primeira ordem real. Saques/transferências devem continuar desabilitados.
