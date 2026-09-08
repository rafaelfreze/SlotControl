# Backtests BTCUSDT locais

Este diretório contém simulações locais e isoladas da estratégia BTCUSDT. Os
motores não importam a aplicação, não acessam Supabase ou Vercel e não criam nem
alteram slots, saldos, gains ou redistribuições do CoinOps produtivo.

## Ambiente e cache

Os scripts usam Python 3.12 e somente a biblioteca padrão. Execute-os a partir
da raiz do repositório. O período histórico congelado dos motores V2–V7 e Meta7
é de `2017-08-17` a `2026-07-31`, em candles Spot BTCUSDT de 1 minuto.

Em um checkout novo, faça o bootstrap do cache mensal pela fonte oficial:

```powershell
python tools/backtests/download_binance_klines.py --interval 1m --start 2017-08-17 --end 2026-07-31 --cache-root backtest-data
```

O downloader é reexecutável: valida os ZIPs já presentes e baixa somente os
meses ausentes. Na primeira execução do V2, a busca de arquivos diários oficiais
tenta preencher as lacunas conhecidas; use `--only-integrity` para executar
somente essa auditoria ou `--skip-gap-fill` para não fazer novas tentativas.
Nenhum candle ausente é inventado.

## Motores e executores

- V2 — `backtest_btc_v2.py`: grade linear reciclável de 25 slots, cenário puro,
  Meta 7 separada e regime ATH separado. Aceita `--start`, `--end`, `--cache`,
  `--reports` e `--output`.
- Calibração V2 — `calibrate_v2_90d.py`: recorte móvel de 90 dias encerrado em
  `--end` (padrão: fim congelado do V2).
- Forense V2 — `audit_v2_entry_forensics.py`: refaz o mesmo recorte de 90 dias
  para provar entradas, rearme, âncora e máximo de slots; também aceita `--end`.
- V3 — `backtest_btc_v3.py`: redistribuição entre slots, reserva e aporte externo
  mínimo. A comparação histórica só é criada quando `--v2-report` aponta para um
  diretório V2 que contenha `summary.json` e `topups.csv`.
- V4 — `backtest_btc_v4.py`: aportes limitados em BRL, câmbio BCB, custódia e
  cenários de recuperação. `--v2-report` e `--v3-report` são independentes e
  opcionais; sem eles o cálculo V4 continua completo e não gera comparação.
- V5 — `run_v5_50slots_ath_redistribution.py`: compara 25/50 slots, regime ATH
  4/2/2 e redistribuição mensal, sem aporte externo.
- V6 — `run_v6_50slots_2pct_monthly_redistribution.py`: 50 slots a 2% fixos e
  redistribuição somente do excedente mensal.
- V7 — `run_v7_open_position_topups.py`: compara 25/50 slots com e sem aporte
  mensal de 2% apenas nas posições abertas, limitado a 1.000 USDT no mês.
- Meta7 — `run_meta7_equalization_open_donors.py`: compara o controle puro com
  equalização Meta 7; doadores abertos preservam a posição e registram o débito
  da redistribuição até a venda.
- Base — `run_base_btc_no_contributions.py`: relatório operacional puro V2, sem
  aporte, reserva, redistribuição ou regime ATH.

O executor `backtest_btc_leader_strategy.py` e seu motor V1 permanecem somente
para reprodução histórica e auditorias antigas; V3/V4 não descobrem mais um
relatório V2 por timestamp fixo.

## Execução

V2, V3 e V4 criam uma pasta datada quando `--output`/`--reports` não define um
destino específico:

```powershell
python tools/backtests/backtest_btc_v2.py --skip-gap-fill
python tools/backtests/backtest_btc_v3.py
python tools/backtests/backtest_btc_v3.py --v2-report reports/backtests/v2-faithful-slot-control/<relatorio-v2>
python tools/backtests/backtest_btc_v4.py --v2-report reports/backtests/v2-faithful-slot-control/<relatorio-v2> --v3-report reports/backtests/v3-redistribution-target/<relatorio-v3>
```

V5, V6, V7 e Meta7 foram divididos para permitir uma execução longa por cenário.
Use sempre a mesma pasta de saída, execute todos os códigos do runner e finalize
somente depois que os JSONs de cenário existirem:

```powershell
python tools/backtests/<runner>.py --output reports/backtests/<familia>/<relatorio> --scenario <codigo>
python tools/backtests/<runner>.py --output reports/backtests/<familia>/<relatorio> --finalize
```

Os códigos são V5 `A B C D`, V6 `A B C D E`, V7 `A0 A1 B0 B1` e Meta7 `A B`.
`--finalize` consolida artefatos já calculados; não substitui os cenários faltantes.

## Testes

Da raiz, cada arquivo de teste pode ser executado isoladamente e a descoberta
completa usa:

```powershell
python -B -m unittest discover -s tools/backtests/tests -v
```

Os testes sintéticos validam invariantes dos motores sem ler o dataset histórico
e sem qualquer conexão produtiva. Eles não substituem a reconciliação dos CSVs e
JSONs de um replay longo.

## Artefatos ignorados

`backtest-data/`, `backtest-cache/`, os diretórios de relatório conhecidos em
`reports/backtests/` e bytecode dentro de `__pycache__/` são ignorados pelo Git.
Código, motores, executores, testes e esta documentação são versionados. Ao usar
um novo caminho de saída fora das famílias já listadas em `.gitignore`, confirme
o status antes de qualquer commit.

Não copie cache ou relatórios entre computadores como fonte de código. Cada host
pode reconstruir o cache público; somente código e documentação são sincronizados
pelo GitHub.

## Limites de interpretação

- No baseline histórico auditado, 4.701.440 candles foram efetivamente lidos e
  8.561 minutos continuam ausentes após as tentativas com arquivos oficiais.
- A ordem intraminuto é heurística: candles bullish percorrem
  `open -> low -> high -> close` e bearish percorrem
  `open -> high -> low -> close`. Eventos dentro do mesmo minuto não são tick a
  tick; `aggTrades` não é baixado automaticamente.
- Resultados financeiros precisam manter separados capital inicial, aportes
  externos, lucro realizado, PnL aberto, redistribuição e patrimônio final.
- Um resultado de backtest é evidência de simulação, não autorização para alterar
  regra, banco, slot, saldo ou operação do CoinOps em produção.
