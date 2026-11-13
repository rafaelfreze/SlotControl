# CoinOps — leitura pública ATH e recuperação automática

## Causa sistêmica e limite da evidência histórica

Samya/BTCUSDT, Executor 02, 13/11/2026 17:40:29 UTC: incidente
`COINOPS_LIVE_ATH_TRANSITION_FAILED`, stage `ATH_TRANSITION`, root
`UNCLASSIFIED_FAILURE`. O ticker público era um GET único com timeout de 8s;
fetch/body podia lançar um erro sem código CoinOps antes de ler o perfil ATH.
O catch o convertia no nome da etapa inteira. Esse nome também representa uma
falha real de UPDATE de transição: nunca liberar todos esses erros por código.

Os logs do incidente são compatíveis com timeout do ticker (intervalo de 8s,
sem GET do perfil desse engine na etapa), mas não preservam a exceção original.
Não afirmar timeout, HTTP503 ou falha de banco como causa histórica comprovada.
O incidente foi resolvido por OPERATOR_CONTROL às 17:58:41 UTC, com 13 posições,
13 TPs e a única BUY do slot14 preservados, antes desta release.

## Fronteira de leitura

`readAthTickerPrice` usa somente o endpoint público oficial
[`GET /api/v3/ticker/price`](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#symbol-price-ticker),
no host de market data já utilizado pelo produto. Mantém o `ath_reference_symbol`
exato do engine; não troca BRL, USDT ou USDC nem usa o preço de outro mercado.

No máximo duas tentativas GET de 4s, intervalo250ms, sem cache/fallback ou
redirecionamento. O happy path continua com um GET. O limite total de observação
é aproximadamente8,25s, próximo dos8s anteriores. Nada envolve ordem/credencial
Binance, alteração de frequência de cron ou repetição de uma etapa financeira.

Timeout, rede e HTTP502/503/504 preservam roots distintos, tentativas, HTTP,
provider numérico permitido e `market/ath_ticker/<símbolo>`. Se o HTTP de falha
contiver código de provedor, só -1000/-1001/-1006/-1007 são transitórios.
Permissão, ban/rate limit, símbolo inválido, código malformado ou não permitido,
JSON inválido200 e preço/símbolo incoerente são erros duros com diagnóstico
sanitizado. Timeout lendo o body de um401/403 não transforma a negativa em retry.

## Checkpoint e retomada

O catch canônico existente mantém a falha transitória em WARNING/RETRY por até
5min. Não avança para ARM_ENTRY, não fabrica reconciliação fresca e não altera
TPs ou a BUY residente. Reconciliação/proteção precedem a leitura ATH. Se durar
mais de5min, fecha apenas as BUYs do próprio engine, preservando diagnóstico.

Ao voltar o provedor, o cron de execução oficial completa reconciliação e
proteção; só então `mayRecoverReadOutage` e `resumeLiveRun` podem executar
`VERIFIED_READ_RECOVERY`. O Watchdog recebe a auditoria de recuperação por
engine/account/run/shard e confirma encerramento. O fast check do Watchdog não
consulta Binance nem se transforma num segundo trader.

Recuperação aceita apenas `COINOPS_LIVE_EXECUTOR_READ_STALE` com stage, path,
roots, tentativas e HTTP/provider exatos desta fronteira. Requer dois GETs
públicos bem-sucedidos para o símbolo configurado e perfil ATH íntegro,
inalterado e igual ao snapshot antes/depois das observações externas. Reutiliza
lease, health, slots completos, Binance/ledger/TP, limites, parents, zero bulk
pendente, decisões/dispatches assentados duas vezes e CAS do incidente inteiro.
Não escreve perfil, slot, ordem, capital ou histórico para recuperar.

Perfil em mudança, edição pendente, fill/dispatch não assentado, TP ausente,
ownership divergente, erro duro ou identidade do incidente alterada permanecem
fechados. PAUSED intencional não retoma. O erro legado UNCLASSIFIED não entra
na nova exceção e seu histórico não é reclassificado.

## Validação e operação

Fixtures isoladas verificam BTC/SOL e referênciaUSDC/USDT, sucesso e retry,
exaustão, HTTP/provider, timeout do body, dados inválidos, proteção antes do
checkpoint, bloqueio local após5min, dois passes de retomada/finance/CAS,
concorrência, edição pendente, caps, falta de TP/slot e isolamento de irmãos.
O teste do cron real demonstra a retomada e a auditoria Watchdog automáticas;
não cria/cancela ordens. Regressões de mês, PRIMARY/RESERVE, preços retidos e
transição real ATH permanecem separadas desta correção.

Release somente web/control plane; sem migration/RLS e sem reinício de VPS.
Atualizar o manifesto de workload pelo gerador versionado; é identidade de
código, não certificado de capacidade. Validar deploy por SHA e cron normal,
Watchdog e ledger; nunca provocar uma indisponibilidade em Production.

Se houver novo bloqueio, guardar root/path/HTTP/provider/tentativas e incidente
exato. Não limpar gates/alertas por SQL nem assumir que todo ATH_FAILED é GET.
