# CoinOps 4.3 — regime ATH

## Escopo e segurança

A Strategy Engine única (`4.3`) continua decidindo Shadow e Binance Spot Testnet. O perfil `REAL` guarda apenas parâmetros futuros: não habilita LIVE nem adiciona escrita na Binance Production. O simulador usa IDs `SIM-*`, funções puras e não acessa banco ou exchange. A rota da simulação exige usuário e produto CoinOps autenticados.

Backend oficial: OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`. A migration `20260923210635_add_robot_v1_ath_profiles.sql` cria perfis e eventos por ambiente/ativo com RLS e adiciona snapshots de configuração, regime e grupos aos ciclos/slots/ordens existentes. Ela não altera ordens nem posições abertas.

## Regras

BTC: defaults oficiais gain 1,2%, queda normal 2%, pós-ATH 5%; meta 7 gains por slot/mês. SOL: 5,5%, 3%, 8%; meta 2. Cada ambiente e ativo possui perfil independente. O perfil rápido atual de Shadow/Testnet é preservado pela seed; os defaults oficiais de REAL não substituem ciclos ativos. Edição de gain/queda normal/queda pós-ATH fica em fila para o próximo ciclo. Um snapshot acompanha ciclo e nova operação/ordem; OPEN e TP existentes permanecem intactos.

O ATH é a máxima de `high` de velas diárias **confirmadas** do histórico BTCUSDC/SOLUSDC da API pública Binance Spot. Não se usa máxima das últimas 24 horas como ATH. Um preço fresco acima da máxima persistida entra em `POST_ATH`, inclusive se já estava nesse regime. Falha ou atraso da fonte não inventa ATH. O retorno a `NORMAL` requer `ath_floor_reference` positivo, menor que o ATH e com origem/data registradas. Sem referência válida não há retorno automático.

Em POST_ATH, são retirados slots não elegíveis e META BATIDA. Até 15 maiores ganhos históricos formam o Primary; dentro dele a ordem operacional é do menor para o maior. Os demais formam Reserve, do maior para o menor, liberada quando não há Primary disponível. O ID e número físicos não mudam. Reentrada local de preço superior e BUY já residente mantêm prioridade, com no máximo uma próxima BUY. Novo ciclo após zerar OPEN conserva o regime e começa com MARKET, seguindo depois a queda configurada. Compounding e metas mensais não reiniciam o total histórico.

## Auditoria e limites de evidência

`REGIME_ATH.csv` mostra perfil, snapshot corrente, grupos e eventos persistidos. Checks ATH em `12_CHECKS_AUDITORIA.csv` distinguem PASS, WARNING e FAIL. A seleção Top 15 é comparável diretamente ao estado corrente apenas antes de fills/fechamentos mudarem a elegibilidade; depois disso o check fica WARNING em vez de comparar indevidamente com o snapshot do grupo. Floor, reset e determinismo do simulador sem fato persistido ficam WARNING: os testes determinísticos não viram prova de execução de mercado. O CSV deixa `simulation_id` vazio, pois simulações são isoladas e não persistidas.

Testes A–G do simulador e o teste de transição Testnet usam mercado/ledger sintéticos isolados. Não forçam ATH no feed operacional. Um ATH real futuro ainda exige smoke de reconciliação e verificação dos TPs/ordens residentes.
