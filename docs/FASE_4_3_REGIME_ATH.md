# CoinOps 4.3 — regime ATH

## Escopo e segurança

Este documento registra a introdução histórica do regime na Strategy Engine única (`4.3`). A descrição original de Shadow/Testnet não autoriza sua reativação: Testnet operacional foi descontinuada em 30/09/2026. Production/LIVE usa a Strategy Engine e o reconciliador oficiais atuais. O simulador usa IDs `SIM-*`, funções puras e não acessa banco ou exchange. A rota da simulação exige usuário e produto CoinOps autenticados.

Backend oficial: OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`. A migration `20260923210635_add_robot_v1_ath_profiles.sql` cria perfis e eventos por ambiente/ativo com RLS e adiciona snapshots de configuração, regime e grupos aos ciclos/slots/ordens existentes. Ela não altera ordens nem posições abertas.

## Regras

Defaults oficiais de novos motores desde 09/10/2026: BTC gain 1,2%, queda normal 2% e pós-ATH 2%, meta 7 gains por slot/mês; SOL gain 5,5%, queda normal 3% e pós-ATH 3%, meta 2. A mudança autorizada nesta data é somente o spacing: gains e metas individuais persistidos não são padronizados. Os dois campos de spacing continuam editáveis individualmente. Cada motor/ambiente possui perfil independente; defaults de cadastro não substituem perfis, ciclos ou snapshots existentes. Seeds e migrations históricas não são reescritas.

Exceção explícita confirmada pelo proprietário em 09/10/2026: Rafael conserva spacing normal BTC 1% e SOL 1,5%, mantendo pós-ATH BTC 2% e SOL 3%. Não igualar esses dois campos nem reescrever uma estratégia individual intencional para fazê-la coincidir com o default. O perfil persistido é a autoridade de execução.

No LIVE, a edição usa o registry canônico de parâmetros e o Bulk Strategy Editor: gain é prospectivo para o próximo ciclo; spacing usa `NEXT_BUY_RECONCILE` apenas quando seu regime está ativo. Atualizar o spacing do regime inativo não toca na BUY residente. Um snapshot acompanha ciclo e nova operação/ordem; OPEN e TP existentes permanecem intactos. Procedimento, confirmação e evidências em `COINOPS_BULK_STRATEGY_RUNBOOK.md` e `COINOPS_SPACING_STANDARDIZATION_20261009.md`.

O ATH é a máxima de `high` de velas diárias **confirmadas** do histórico BTCUSDC/SOLUSDC da API pública Binance Spot. Não se usa máxima das últimas 24 horas como ATH. Um preço fresco acima da máxima persistida entra em `POST_ATH`, inclusive se já estava nesse regime. Falha ou atraso da fonte não inventa ATH. O retorno a `NORMAL` requer `ath_floor_reference` positivo, menor que o ATH e com origem/data registradas. Sem referência válida não há retorno automático.

Em POST_ATH, são retirados slots não elegíveis e META BATIDA. Até 15 maiores ganhos históricos formam o Primary; dentro dele a ordem operacional é do menor para o maior. Os demais formam Reserve, do maior para o menor, liberada quando não há Primary disponível. O ID e número físicos não mudam. Reentrada local de preço superior e BUY já residente mantêm prioridade, com no máximo uma próxima BUY. Novo ciclo após zerar OPEN conserva o regime e começa com MARKET, seguindo depois a queda configurada. Compounding e metas mensais não reiniciam o total histórico.

## Auditoria e limites de evidência

`REGIME_ATH.csv` mostra perfil, snapshot corrente, grupos e eventos persistidos. Checks ATH em `12_CHECKS_AUDITORIA.csv` distinguem PASS, WARNING e FAIL. A seleção Top 15 é comparável diretamente ao estado corrente apenas antes de fills/fechamentos mudarem a elegibilidade; depois disso o check fica WARNING em vez de comparar indevidamente com o snapshot do grupo. Floor, reset e determinismo do simulador sem fato persistido ficam WARNING: os testes determinísticos não viram prova de execução de mercado. O CSV deixa `simulation_id` vazio, pois simulações são isoladas e não persistidas.

Testes A–G do simulador e o teste de transição Testnet usam mercado/ledger sintéticos isolados. Não forçam ATH no feed operacional. Um ATH real futuro ainda exige smoke de reconciliação e verificação dos TPs/ordens residentes.
