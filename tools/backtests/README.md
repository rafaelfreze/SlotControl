# Backtest BTC — slot líder

Este diretório contém um simulador **local e isolado** da estratégia BTCUSDT. Ele
não importa código da aplicação, não acessa Supabase/Vercel e não cria nem altera
slots reais.

## Execução rápida

Na raiz do repositório, com Python 3.12+:

```powershell
python tools/backtests/backtest_btc_leader_strategy.py --download --run-all
```

O comando baixa somente os meses 1m ainda ausentes de `backtest-data/binance/`, valida
o CSV dentro de cada ZIP e gera um diretório datado em
`reports/backtests/slot-control-btc-leader/`. Os ZIPs e o estado de download são
ignorados pelo Git; os relatórios não são enviados automaticamente.

Para uma execução curta de validação, sem rede:

```powershell
python tools/backtests/backtest_btc_leader_strategy.py --start 2022-11-21 --end 2022-12-31
```

Use `--download` antes quando os meses ainda não estiverem no cache. Para apenas
o cenário principal, use `--download` sem `--run-all`.

## Premissas reproduzidas

- BTCUSDT Spot Klines da Binance Data Vision, em ZIP mensal.
- O leitor aceita timestamps históricos em milissegundos e arquivos recentes em
  microssegundos, ambos publicados pela fonte.
- Entrada inicial no `close` do primeiro candle; reinício de ciclo no `open` do
  candle seguinte ao fechamento de todas as posições.
- Compra no gatilho de queda de 2% linear a partir da âncora e venda no alvo
  individual de 1%. O retorno de 1% já é líquido: não há desconto adicional.
- O valor de um slot é composto em 1% tanto em gain real como no aporte de meta.
- O caixa corresponde à soma dos valores dos slots livres; posições abertas são
  marcadas pelo `close` do último candle.

## Ambiguidade OHLC

`heuristic` percorre `open -> low -> high -> close` em candles bullish e
`open -> high -> low -> close` em bearish. `conservative` abre compras primeiro
no mínimo e só permite saídas de posições já abertas antes do candle; logo, não
realiza uma compra e sua venda no mesmo OHLC. Isso é deliberadamente pessimista.
O relatório registra os candles que poderiam misturar entrada e saída.

`aggTrades` não é acionado automaticamente: a Data Vision fornece esses dados em
outro conjunto grande e a resolução seletiva exige uma janela temporal adicional.
O campo de ambiguidade deixa explícita a quantidade ainda não resolvida.

## Testes

```powershell
python -m unittest discover -s tools/backtests/tests -v
```

## Auditoria independente de um relatório

```powershell
python tools/backtests/audit_backtest_artifacts.py --cache backtest-data --report reports/backtests/slot-control-btc-leader/<relatorio>/forensic-rerun-1m
```

O comando grava `independent_forensic_validation.json` com perfil do cache,
unicidade mensal dos aportes, recálculo da fórmula e validação do rank do líder.
