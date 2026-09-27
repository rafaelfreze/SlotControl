# Saúde do Ativo — fontes, métricas e regras

Módulo informativo, read-only em relação ao trading. Implementação: `apps/web/lib/coinops-asset-health/{sources,rules,types}.ts`. Não usa LLM, credencial Binance, carteira, endpoint privado ou operação de exchange. O status não alimenta Strategy Engine, Capacity Manager, watchdog financeiro, BUY/SELL/TP, NEXT BUY, ciclos, slots ou kill switches.

## Coleta e validade

| Grupo | Coleta server-side | TTL da observação válida | Chamadas por rodada |
|---|---|---|---|
| FAST | 30 minutos | 2 horas | 10 requisições HTTP públicas: 3 BTC rede, 4 Binance pública, 2 Solana RPC, 1 status Solana |
| STRUCTURAL | 6 horas | 12 horas | 6 requisições: 2 mineração, 1 vote accounts, 3 DefiLlama |
| DEVELOPMENT | 24 horas | 48 horas | 6 requisições GitHub: último commit e release de 3 projetos |

Cada requisição tem timeout de 9 segundos. Fontes independentes são consultadas em paralelo. O timestamp de coleta (`fetchedAt`), observação válida (`observedAt`) e evento medido (`metricAt`) são distintos. Um release antigo consultado agora não é dado stale; sua idade é uma regra de desenvolvimento. O mesmo vale para a última alteração da página de status.

Falha de coleta preserva o último valor válido somente até seu TTL original, com `collectionStatus=SOURCE_UNAVAILABLE`, `errorCode` e `errorAt`. Não renova a idade. Evidência expirada vira `DATA_STALE`. Resposta nula/inválida não vira zero. Não há retry contínuo. A próxima coleta periódica tenta novamente.

## Fontes e endpoints reais

### Bitcoin

- [mempool.space REST API](https://mempool.space/docs/api/rest): explorer aberto reconhecido, evidência de rede/mineração. `GET https://mempool.space/api/blocks`; `GET https://mempool.space/api/mempool`; `GET https://mempool.space/api/v1/mining/hashrate/1m`; `GET https://mempool.space/api/v1/mining/pools/1m`.
- [Blockstream Esplora API](https://github.com/Blockstream/esplora/blob/master/API.md): confirmação independente da produção mais recente. `GET https://blockstream.info/api/blocks`.
- [Bitcoin Core](https://github.com/bitcoin/bitcoin), via [GitHub REST](https://docs.github.com/en/rest): `GET https://api.github.com/repos/bitcoin/bitcoin/commits?per_page=1`; `GET https://api.github.com/repos/bitcoin/bitcoin/releases/latest`.
- [Binance dados de mercado públicos](https://developers.binance.com/docs/binance-spot-api-docs/faqs/market_data_only): `GET https://data-api.binance.vision/api/v3/ticker/24hr?symbol=BTCUSDT`; `GET https://data-api.binance.vision/api/v3/depth?symbol=BTCUSDT&limit=20`. Sem API key ou IP dos executores.

### Solana

- [Solana RPC oficial](https://solana.com/docs/rpc): `POST https://api.mainnet-beta.solana.com`, somente métodos de leitura `getHealth`, `getEpochInfo` com commitment finalized, [`getRecentPerformanceSamples`](https://solana.com/docs/rpc/http/getrecentperformancesamples) (5 amostras), `getBlockTime` para slot finalizado e [`getVoteAccounts`](https://solana.com/docs/rpc/http/getvoteaccounts). `getPerformanceSamples` não existe e não é usado.
- [Status oficial](https://status.solana.com): `GET https://status.solana.com/api/v2/summary.json`, status e incidentes ativos. Status e RPC pertencem ao grupo de independência `solana-official`; não contam como duas organizações independentes para risco estrutural.
- [Agave/Anza](https://github.com/anza-xyz/agave) e [Firedancer](https://github.com/firedancer-io/firedancer): GitHub `/repos/{owner}/{repo}/commits?per_page=1` e `/releases/latest`.
- [DefiLlama e metodologia](https://docs.llama.fi/): `GET https://api.llama.fi/v2/chains`; `GET https://stablecoins.llama.fi/stablecoincharts/Solana`; `GET https://api.llama.fi/overview/dexs/Solana?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`.
- Binance pública, mesmos endpoints BTC com `symbol=SOLUSDT`.

Os endpoints acima responderam durante as verificações públicas de 27/09/2026. Isso é evidência pontual, não garantia futura de disponibilidade. Coletor sempre valida formato, ausência de valores e status HTTP antes de produzir métrica.

## Métricas e thresholds determinísticos

Todos os limiares são heurísticas internas conservadoras de acompanhamento, não probabilidades científicas nem recomendações de investimento. Alterá-los exige revisão do código/testes. `CRITICAL` em uma métrica isolada não equivale a `STRUCTURAL_RISK` do ativo.

| Métrica | Medida | Atenção | Crítico |
|---|---|---|---|
| BTC intervalo de blocos | Média dos intervalos recentes do explorer | >20 min | >35 min |
| BTC último bloco, duas fontes | Idade do bloco observado em cada explorer | >30 min | >60 min |
| BTC hashrate | Hashrate atual / média da série mensal disponível | <70% | <50% |
| BTC dificuldade | Dificuldade atual positiva | — | Valor inválido é indisponível |
| BTC pool dominante | Maior contagem de blocos / total identificado no mês | >50% | >65% |
| BTC volume Spot Binance | Volume de cotação 24h BTCUSDT | <100 milhões USDT | <25 milhões USDT |
| SOL volume Spot Binance | Volume de cotação 24h SOLUSDT | <20 milhões USDT | <5 milhões USDT |
| Spread BTC/SOL | `(ask-bid)/mid * 100` | >0,1% | >0,5% |
| SOL tempo por slot | Média `samplePeriodSecs/numSlots` | >1 s | >3 s |
| SOL bloco finalizado | Idade do `getBlockTime` do slot finalizado | >2 min | >15 min |
| SOL atividade não-voto | `numNonVoteTransactions/samplePeriodSecs` | Zero | — |
| SOL status oficial | Indicador público oficial | minor | major/critical |
| SOL contas de voto ativas | Número em `getVoteAccounts.current` | <500 | <200 |
| SOL stake delinquent | Stake delinquent / stake total observado | >10% | >25% |
| SOL concentração de stake | Contas de voto necessárias para somar 1/3 do stake observado | <20 | <10 |
| SOL stablecoin supply | Total USD atual / total de 30 dias antes | <70% | <40% |
| Desenvolvimento Core/Agave/Firedancer | Dias desde último commit no repositório | >90 dias | >180 dias |

Ressalvas de medida:

- Pool de mineração não identifica controle comum dos mineradores; participação em blocos é proxy de hashrate e tem variância.
- Contagem Solana mede contas de voto, não necessariamente operadores independentes. A concentração de 1/3 é um proxy sem agrupamento por entidade, explicitamente diferente do coeficiente Nakamoto oficial.
- TPS informado exclui votos. Atividade não-voto pode conter bots, spam e operações sem valor econômico; não equivale a usuários.
- Liquidez representa Binance Spot e spread do topo de livro. Não mede toda a liquidez mundial, slippage para uma posição específica ou disponibilidade em todas as exchanges.
- A série de stablecoins usa metodologia DefiLlama e pode variar por migração/depeg/classificação. Precisa de histórico de 30 dias; série com última data há mais de 3 dias é indisponível.
- TVL e volume DEX em USD são apenas contexto (`contextOnly`); não entram no total de indicadores, cobertura mínima ou risco. Variação de preços/bots/dupla contagem pode afetá-los.
- Mempool é contexto; congestionamento isolado não é risco estrutural.
- Commit recente indica manutenção observada, não qualidade, segurança ou ausência de vulnerabilidades.

## Status reproduzível

- BTC exige pelo menos 6 indicadores disponíveis nas categorias rede, segurança, desenvolvimento e liquidez; SOL exige pelo menos 8 nas cinco categorias, incluindo ecossistema. Ambos exigem pelo menos 3 grupos de fontes independentes na cobertura. As contagens reais podem exceder o mínimo.
- Sem cobertura suficiente: `INSUFFICIENT_DATA` (DADOS INSUFICIENTES). API ausente/stale jamais vira risco do ativo.
- Cobertura suficiente e nenhum indicador degradado: `HEALTHY` dentro da cobertura declarada.
- Um ou mais indicadores warning/critical: `ATTENTION`.
- `STRUCTURAL_RISK` exige métricas críticas persistentes em pelo menos 2 categorias e 2 grupos independentes de fontes por pelo menos 6 horas. A data de início fica persistida por `source.id:key` em `criticalSinceByMetric`.
- A confirmação precisa ter `observedAt >= criticalSince + 6h`: passagem do relógio ou GET da página não promove status. Uma amostra crítica antiga, sem nova coleta, não comprova persistência.
- Uma fonte independente saudável para a mesma métrica crítica impede sua contribuição para escalada estrutural; a divergência continua em atenção e fica visível nas métricas.
- Intervalo de mais de 2 horas entre avaliações quebra continuidade. Uma leitura saudável limpa o início crítico. Falha transitória de fonte pode preservar risco já comprovado dentro do TTL, mas não iniciar ou ampliar persistência usando cache.
- Preço/candle/retorno não é entrada admitida no motor. Queda extrema de preço isolada não gera risco. O coletor ignora `priceChangePercent` do ticker.

## Limitações explícitas

- Participação por stake de Agave/Firedancer/outros clientes: `SOURCE_UNAVAILABLE`, opcional. Não inferida de `getVersion` ou do número de releases. Desenvolvimento dos clientes é acompanhado, diversidade instalada não é.
- Feed completo de vulnerabilidades críticas confirmadas: `SOURCE_UNAVAILABLE`, opcional. A ausência de feed não atesta ausência de vulnerabilidade.
- Nakamoto por operador, concentração geográfica/datacenter, regulação e disponibilidade de todas as grandes exchanges não possuem coleta automática nesta versão.
- Não há baseline histórico local anterior à primeira implantação. O histórico começa com os snapshots reais do módulo; nada é retroativamente inventado.
- Fontes grátis, nenhuma contratação/API key adicional. Limites públicos podem mudar; falhas são mostradas e não afetam trading.

## Evidência pontual da coleta pública

Coleta em `2026-09-27T10:57:15.381Z`, duração aproximada de 2,4 segundos, antes da última inclusão de idade do bloco Solana:

- BTC: regra derivada `HEALTHY`, 9 indicadores core disponíveis. Fatos: intervalo médio de blocos 9,38 min; tip em ambas fontes 22,69 min; hashrate ~957,94 EH/s, 102,99% da referência mensal; maior pool 25,48%; volume Binance ~833,29 milhões USDT/24h. Bitcoin Core último commit `2026-09-25T23:24:00Z`, release v31.1.
- SOL: regra derivada `ATTENTION`, decorrente exclusivamente do proxy de concentração de 18 contas de voto para 1/3 do stake, abaixo do limiar interno 20. Não indica outage, trade recomendado ou risco estrutural. Fatos: 676 contas de voto ativas; stake delinquent 0,0083%; 0,267 s/slot; ~1684 tx não-voto/s; status oficial operacional; stablecoins ~16,804 bilhões USD, 103,44% de 30 dias antes. Agave release v4.3.0; Firedancer v26.09.4.
- Confirmação adicional em `2026-09-27T10:59:33.067Z`: bloco finalizado Solana com 7,1 segundos de idade, RPC e status oficial saudáveis. Essa métrica eleva a cobertura core disponível para 13.

Esses valores são evidência datada do desenvolvimento, não o estado permanente mostrado pela aplicação. Production consulta apenas snapshots atuais persistidos.

## Regressões

`apps/web/lib/coinops-asset-health/asset-health.test.ts`: BTC/SOL saudáveis, degradação única, persistência multifonte, recuperação, origem comum, fontes conflitantes, lacuna de coleta, GET sem promoção por relógio, risco comprovado com falha transitória de fonte, último valor dentro/fora do TTL, data antiga de evento, cobertura insuficiente, lacunas opcionais, preço extremo, dedupe de transições, formato RPC correto/TPS sem votos, null indisponível, todas APIs offline e isolamento de imports/chamadas de trading.
