# Saúde do Ativo — entrega e evidência Production

Data: 27/09/2026. Evidências UTC; Cuiabá = UTC−4. Este documento diferencia fatos medidos, regras derivadas e lacunas. Não é recomendação de investimento.

## 1. Arquitetura

COMPROVADO: fontes públicas → coletor server-side Vercel → normalização/última evidência válida → regras determinísticas → RPC transacional → snapshots/current/eventos → API autenticada → badges/drawer. Sem LLM e sem dependência de navegador, PC ou Codex.

## 2. Fontes BTC

[mempool.space](https://mempool.space/docs/api/rest), [Blockstream Esplora](https://github.com/Blockstream/esplora/blob/master/API.md), [Bitcoin Core](https://github.com/bitcoin/bitcoin) e [Binance market-data-only](https://developers.binance.com/docs/binance-spot-api-docs/faqs/market_data_only). Endpoints e metodologia estão em [Fontes e regras](./COINOPS_ASSET_HEALTH_SOURCES.md).

## 3. Fontes SOL

[RPC oficial Solana](https://solana.com/docs/rpc), [status oficial](https://status.solana.com), [Agave](https://github.com/anza-xyz/agave), [Firedancer](https://github.com/firedancer-io/firedancer), [DefiLlama](https://docs.llama.fi/) e Binance pública. RPC e status oficial não são contados como organizações independentes.

## 4. Métricas BTC

Intervalo/idade de blocos, confirmação por segundo explorer, mempool contextual, hashrate e referência mensal, dificuldade, concentração de pools, atividade/release Core, volume Spot e spread. Nove indicadores centrais disponíveis na primeira coleta publicada.

## 5. Métricas SOL

RPC health, produção de slots, idade do bloco finalizado, status/incidentes oficiais, atividade não-voto, contas de voto ativas, stake delinquent, concentração por conta de voto, desenvolvimento Agave/Firedancer, oferta de stablecoins, volume Spot e spread. TVL/DEX apenas contexto. Treze indicadores centrais disponíveis.

## 6. Frequências

COMPROVADO: cron publicado `7,37 * * * *` em Production. FAST 30min, STRUCTURAL 6h, DEVELOPMENT 24h. TTL 2h/12h/48h. Snapshot da avaliação expira em até 90min. Lease 5min, cooldown 20min, timeout por fonte 9s. Watchdog observa o singleton e registra observação no máximo a cada 5min.

## 7. Algoritmo/status

REGRA DERIVADA: cobertura mínima + ausência de quórum de degradação → SAUDÁVEL. Indicadores são classificados como CRITICAL, PRIMARY ou COMPLEMENTARY_PROXY. ATENÇÃO exige dois PRIMARY deteriorados de grupos independentes, ou um CRITICAL confirmado e de alta confiança. Um proxy isolado fica OBSERVAR no drawer e não rebaixa o global. RISCO ESTRUTURAL exige evidência crítica não-proxy em pelo menos duas categorias e duas fontes independentes, com novas observações confirmando pelo menos 6h de persistência. Cobertura insuficiente → DADOS INSUFICIENTES. Não existe média cega e nenhum número representa probabilidade de perda.

## 8. Thresholds

Todos versionados e documentados em [Fontes e regras](./COINOPS_ASSET_HEALTH_SOURCES.md#metricas-e-thresholds-deterministicos). Exemplos: BTC hashrate abaixo de 70%/50% da referência mensal; SOL stake delinquent acima de 10%/25%; spread acima de 0,1%/0,5%. Concentração SOL abaixo de 20/10 contas de voto para 1/3 do stake é observação complementar interna. Não é Nakamoto por operador e não participa sozinha do quórum global. Estes limiares são heurísticas explícitas, não consenso oficial.

## 9. Falso positivo

COMPROVADO por testes: 12 indicadores saudáveis + 1 proxy degradado permanecem globalmente SAUDÁVEIS; dois PRIMARY independentes justificam ATENÇÃO; um CRITICAL confirmado pode justificar ATENÇÃO; múltiplas deteriorações críticas persistentes podem chegar a RISCO ESTRUTURAL. Queda extrema de preço não gera risco; preço/candle/retorno são entradas proibidas. TVL/volume DEX/mempool não elevam risco. API fora não vira falha de rede. Fonte independente conflitante impede contribuição daquela métrica para escalada estrutural. GET nunca promove status pelo simples decurso do relógio.

## 10. Stale data

Falha preserva última evidência válida sem renovar observedAt/TTL. Expiração marca DATA_STALE; cobertura insuficiente fica explícita. Cache crítico não inicia nem amplia persistência. Lacuna maior que 2h entre avaliações interrompe a continuidade. Optional indisponível é lacuna declarada, não falha do coletor.

## 11. Persistência

COMPROVADO: cinco tabelas `asset_health_*`; RPCs claim/finish/fail com fencing, timestamps monotônicos e transação conjunta de ativos/cadências/eventos. Primeira coleta Production persistiu dois snapshots reais, nenhum evento de transição inicial e nenhuma entrega artificial.

## 12. Histórico

Snapshots imutáveis e eventos antes/depois com trigger, razões, métricas/fontes e timestamp. UI permite 30/90/365 dias; retorna até 500 mudanças recentes combinadas. Não existe histórico anterior à implantação; observação real de longo prazo ainda NÃO TESTADA.

## 13. Alertas

COMPROVADO em fixtures/SQL: outbox separada, dedupe evento/dispositivo, lease e retries limitados, ADMIN ativo, preferências warning preservadas, bootstrap/mesmo status não notificam. Nenhum incidente LIVE é criado pelo módulo. Entrega física Web Push não foi provocada nem comprovada; crash após envio e antes de SENT pode reenviar (at-least-once, tag/topic estável).

## 14. UI

Os dois cards atuais BTC/USDT e SOL/USDT da Home Todos recebem badge discreto e idade da avaliação. Nenhum novo card grande. Uma leitura compartilhada, cache cliente 5min, dedupe in-flight, sem APIs externas no frontend.

## 15. Drawer

Status, explicação leiga, categorias, cobertura, histórico e seções recolhíveis de riscos/condições/fontes/métricas. Reutiliza portal acessível com fechamento fixo, foco e Escape. Deep link por allowlist BTC/SOL. Abertura/fechamento após scroll comprovados em fixtures mobile/desktop.

## 16. Segurança

GET exige Auth e vínculo CoinOps ativo. VIEWER precisa vínculo ativo, operador do tenant oficial e conta pertencente ao operador; a conta não possui coluna tenant_id, portanto o tenant é validado no operador canônico. POST é ADMIN-only, mesma origem e não aceita force/provider/escopo arbitrário. Rotas API/cron sem autenticação retornaram HTTP 401 em Production.

## 17. Isolamento do trading

COMPROVADO: nenhuma alteração de executores, ordens, Strategy Engine, preços, ciclos, slots, credenciais, admission ou kill switches. Módulo não importa fluxo de execução financeira. Watchdog apenas observa o coletor separadamente; resultado do ativo não entra na saúde/recuperação dos motores. AGENTS registra essa fronteira permanentemente.

## 18. Custos/APIs

Nenhuma API paga, contratação, token novo ou serviço hipotético. Aproximadamente 510 HTTP públicos/dia, 96 snapshots/dia. Quatro chamadas públicas Binance/30min pela Vercel, nenhuma pelo IP dos executores. Reutiliza Vercel/Supabase já inventariados no FinOps; custo incremental exato não medido, não declarado zero. Primeira coleta publicada: 2.565ms.

## 19. Testes

- 49/49 testes direcionados: regras/fontes 23, serviço/Auth/cron 11, push 8, UI 7; todos aprovados no ajuste de quórum.
- 10/10 testes SQL em PostgreSQL 17 real descartável: transação, concorrência, fencing, replay, rollback, RLS/grants, imutabilidade e dedupe.
- 12/12 cenários Chromium/WebKit, 320/360/375/390/430/1280px; reteste de cor em 375px nos dois browsers.
- Lint, typecheck, build e diff check aprovados para o bloco de implementação.
- Compatibilidade VIEWER com schema real recebeu regressão específica no fechamento.

## 20. Git/SHA/main

Implementação principal `131f72d74e1f365bc57a6ef57aee1c8f5510966b`; regra antifalso-positivo `b304bf988cda3e08585fa69a77ca092967933798`, ambos publicados por fast-forward de `codex/coinops-executor-02` para GitHub/main. Alterações locais preexistentes de outros trabalhos preservadas e fora do staging.

## 21. Migration/RLS

COMPROVADO: `20260927110357_add_coinops_asset_health.sql` aplicada no projeto `otdfpmsegjxpqrzisfmi`, schema `coinops`, e versão local alinhada ao registro remoto. Cinco tabelas com RLS habilitada/forçada, sem SELECT anon/authenticated; acesso pelo backend autorizado. Histórico append-only. Nenhuma migration de trading.

## 22. Vercel

Primeiro deployment Production READY: `dpl_ATm5CWQPx5PnDVDc2yUnUBQHqM1s`, SHA `131f72d`. Ajuste antifalso-positivo READY em `dpl_3r7Hy3uEGEzvPuqhcT2B8mafKSRX`, SHA `b304bf9`, domínio `cripto-flax.vercel.app` apontando para esse deployment. Reavaliação pelo cron oficial às `2026-09-27T12:28:12.013Z`; coletor HEALTHY, zero falhas de fonte.

## 23. Smoke mobile

COMPROVADO em fixtures locais: badges compactos, sem overflow, drawer fechável após scroll, Escape, histórico e dedupe, sem chamadas financeiras. Screenshots em `apps/web/test-results/automation-premium-asset-h-0f415-s-and-closable-drawer-375px-mobile-webkit-iphone/` (`asset-health-cards-375.png`, `asset-health-375.png`). NÃO TESTADO em Safari físico. Smoke visual autenticado Production BLOQUEADO: Chrome conectado não respondeu ao controle do Codex; reconexão foi solicitada. Não se apresenta teste local como smoke Production.

## 24. BTC — status atual da evidência

REGRA DERIVADA: antes SAUDÁVEL 9/9; depois SAUDÁVEL 9/9. Reavaliação `2026-09-27T12:28:12.013Z` (08:28:12 Cuiabá). Não significa ausência universal de risco.

## 25. BTC — justificativa

FATO MEDIDO: intervalo médio 8,28min; bloco mais recente há 1,88min em dois explorers; hashrate ~956,4 EH/s, 102,82% da referência mensal; maior pool 25,47%; volume BTCUSDT 835,83 milhões USDT/24h; Core com commit de 25/09 e release v31.1. Nenhum limiar de degradação atingido nessas evidências. DADO INDISPONÍVEL: feed completo de vulnerabilidades críticas e demais dimensões não cobertas.

## 26. SOL — status atual da evidência

REGRA DERIVADA: antes ATENÇÃO 12/13 por um proxy isolado; depois SAUDÁVEL 12/13. A categoria Segurança permanece `OBSERVE`, visível no drawer. Motivo observado: proxy de concentração por contas de voto, sem quórum para rebaixar o global. Não é outage, recomendação de trade ou risco estrutural.

## 27. SOL — justificativa

FATO MEDIDO: 18 contas de voto acumulam 1/3 do stake observado. É `COMPLEMENTARY_PROXY`, sem agrupamento por operador, e não é coeficiente Nakamoto oficial. REGRA DERIVADA: esse proxy isolado não satisfaz nenhuma das condições de ATENÇÃO. As outras 12 métricas centrais permanecem saudáveis; rede, desenvolvimento, liquidez e ecossistema estão HEALTHY na avaliação, enquanto Segurança fica OBSERVE. DADO INDISPONÍVEL: diversidade instalada por stake, Nakamoto atual por operador e feed completo de vulnerabilidades.

## 28. Fontes e timestamps atuais

Reavaliação publicada em `2026-09-27T12:28:12.013Z` pelo fluxo server-side. Ela reutilizou somente evidências ainda dentro do TTL: FAST concluído às `12:07:37.556Z`; STRUCTURAL/DEVELOPMENT às `11:16:39.201Z`; observação do proxy às `11:16:36.785Z`. Não houve falsificação de `fetchedAt`/`observedAt`, e nenhuma cadência foi marcada como coletada novamente. Consultar snapshots atuais para fatos posteriores.

## 29. Gates

| Gate | Resultado e limite da prova |
|---|---|
| ASSET_HEALTH_SERVER_SIDE_ACTIVE | PASS — cron publicado, HTTP200, snapshots reais, monitor HEALTHY |
| BTC_HEALTH_ACTIVE | PASS — snapshot BTC real persistido |
| SOL_HEALTH_ACTIVE | PASS — snapshot SOL real persistido |
| MULTISOURCE_DATA_PASS | PASS — fontes reais + grupos independentes explícitos |
| STALE_DATA_PROTECTION_PASS | PASS — regressões, sem falha artificial Production |
| STRUCTURAL_HEALTH_ENGINE_PASS | PASS — regras determinísticas e regressões |
| FALSE_POSITIVE_PROTECTION_PASS | PASS — proxy isolado testado e corrigido em Production; preço/API/ruído/conflito também testados |
| HEALTH_HISTORY_PASS | PASS — persistência real e testes; 30/90/365 dias ainda não transcorridos |
| HEALTH_ALERTS_PASS | PARCIAL — outbox/dedupe/segurança testados; push físico não testado |
| HOME_CARD_HEALTH_PASS | PASS local; smoke autenticado Production bloqueado pelo Chrome |
| HEALTH_DRAWER_PASS | PASS local; Safari físico/Production autenticado não comprovados |
| TRADING_READ_ONLY_ISOLATION_PASS | PASS — fronteira de código/testes e checagem Production somente leitura |

Checagem Production às `11:18:57Z`: nove motores ACTIVE, 25 slots cada, dez posições com dez TPs NEW e nove ENTRY/NEXT BUY NEW; reconciliação mais antiga 41,6s, nenhum last_error, nenhum kill switch de conta e zero alertas LIVE pendentes. Watchdog: Executor01 7/7, Executor02 2/2 saudáveis. Contas preservadas: Rafael BTCBRL/SOLBRL; Thyely BTCUSDT/SOLUSDT; Caixeta BTCBRL/SOLBRL; Pedro SOLBRL; Diogo SOLBRL; Elizelena SOLBRL. Prova baseada no ledger e reconciliação normal existentes; nenhuma nova consulta financeira Binance ou ordem de teste.

## 30. Limitações e rollback

Não são cobertos todos os riscos regulatórios, geográficos, econômicos, clientes por stake, vulnerabilidades ou exchanges. Fontes gratuitas podem limitar/falhar; arquitetura mostra a lacuna, não adivinha. Histórico longo e entrega física push exigem evidência futura. Smoke visual autenticado depende de restabelecer conexão Chrome.

Rollback: reverter os commits deste módulo ou promover o deployment do SHA `1c40e4a` (preserva a correção dos gains); manter tabelas/histórico aditivos. Não reiniciar executores, restaurar ledger, mudar secrets ou cancelar ordens. Falha de fonte informativa não justifica rollback do trading.
