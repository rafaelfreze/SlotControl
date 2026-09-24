# Índice da documentação

## Regras oficiais do CoinOps

- [Operador multi-account/multi-market 5.6](./COINOPS_MULTI_ACCOUNT_OPERATOR_5_6.md) — identidade, isolamento por conta/motor/moeda, executor, onboarding e rollout compatível; gates dependem da evidência de fechamento.
- [Automação premium 5.5](./COINOPS_AUTOMATION_PREMIUM_5_5.md) — design system dos quatro ambientes, paridade funcional, drawers e smoke sem ordens.
- [Preparação LIVE 5.1 em BRL](./COINOPS_LIVE_PREPARATION_5_1.md) — BTCBRL/SOLBRL, filtros GET, capital, hard caps, preview e LIVE bloqueado.
- [Auditoria adversarial pré-LIVE 5.0](./COINOPS_PRE_LIVE_AUDIT_5_0.md) — ledger, concorrência, recovery, metas, ATH, snapshots e gate somente leitura.
- [Strategy Engine 4.1](./STRATEGY_ENGINE_4_1.md) — decisões únicas Shadow/Testnet, correção de cache, reactor de um minuto, missed e auditoria.
- [Auditoria temporal 4.1.1](./COINOPS_PHASE_4_1_1_TEMPORAL_AUDIT.md) — evidência BTC/SOL, marco exato 4.1.0, histórico versus estado atual e limites da classificação.
- [Metas mensais e rank 4.2](./COINOPS_PHASE_4_2_MONTHLY_GOALS.md) — ledger mensal, elegibilidade por slot físico, rank, prioridade de preço e auditoria Shadow/Testnet.
- [Regime ATH 4.3](./FASE_4_3_REGIME_ATH.md) — ATH confirmado, Top 15/Reserve, perfis por ambiente, simulador isolado e evidência de auditoria.

- [Marco do capital operacional](./MARCO_CAPITAL_OPERACIONAL.md) — reinício auditável dos contadores de aportes/gains adicionados, preservando saldos, posições, histórico e monitoramento.
- [Estratégia oficial pós-baseline](./ESTRATEGIA_OFICIAL_2026.md) — corte em 27/08/2026, modos Normal/Defensivo, ciclos de 30 dias, filas, pools 1–25/26–50, relatórios e exportações auditáveis.
- [Escada de Redistribuição BTC e SOL](./ESCADA_REDISTRIBUICAO_BTC.md) — fonte oficial das metas mensais configuráveis, referência assistida, igualdade funcional entre os ativos, separação entre gains reais e operacionais, conversão financeira, ledger, idempotência e proteção de posições abertas.
- [Execution Engine Binance — Shadow](./EXECUTION_ENGINE_SHADOW.md) — fronteira estratégia/exchange, persistência de intenções, integração Binance somente leitura, reconciliação auditável e proteções fail-closed.

## Visão geral

- [README do projeto](../README.md) — stack, execução local, validações e resumo funcional.

## Limites de autoridade

Os arquivos em `tools/backtests/`, `reports/`, `backtest-data/` e `backtest-cache/` são experimentos e evidências de simulação. Eles não definem regras financeiras do CoinOps real e não podem substituir esta documentação, as migrations versionadas ou o código de domínio usado pela aplicação.
