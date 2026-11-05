# Proteção de execução contra quedas — estudo 05/11/2026

**Resultado: NÃO CERTIFICADA para LIVE. Protótipo isolado, sem integração ou chave
de ativação no runtime. Nenhuma operação LIVE foi realizada por este estudo.**

O detector/protocolo e o replay passaram nos52 testes offline. Isso demonstra comportamento
das funções puras e das fixtures; não demonstra atomicidade financeira, Binance,
RLS, leases reais ou Watchdog integrado. A proteção deve permanecer desativada.

## Fontes e reprodução

Fonte: [arquivo oficial Binance Spot](https://github.com/binance/binance-public-data)
e [Binance Data Vision](https://data.binance.vision/). CSVs locais já normalizados
emUTCms, hashSHA256 reconfirmado contra o manifesto compacto público
`data-manifest.json` desta pasta. A origem histórica8082479 é apenas proveniência;
o runner não depende desse objeto Git nem da antiga branch local. Não houve novo download nem rede no replay.
Os documentos de formato e cancelamento foram consultados no site oficial em
05/11/2026; o replay não supõe que isso prove filtros ou taxas históricas.

| Mercado nativo | Candles5m | Início dos dados | Gaps | Volume zero |
|---|---:|---|---:|---:|
| BTCBRL |525675|01/01/2021|7|389|
| BTCUSDT |525675|01/01/2021|7|32|
| SOLBRL |477290|18/06/2021|3|46875|
| SOLUSDT |525675|01/01/2021|7|31|

Todos terminam no fechamento conhecido01/01/2026 00:00UTC. Treino2021,
walk-forward2022–2025, sem olhar preços futuros. BRL eUSDT são séries nativas
independentes, sem conversão sintética. Há80min sem observação durante o período
econômico de cada mercado. Lacunas interrompem confirmação, não são interpoladas.
O cache abrange bear2022, FTX/SOLnov2022, flashjan2024, quedaoct2025, recuperação,
laterais e alta persistente. Dados5m não revelam trajetória intrabar nem fila,
spread, depth, filtros históricos ou cancelamento real. SOLBRL tem9,82% de barras
sem negócios; preço sem negociação pode atrasar a percepção de velocidade.

```powershell
node --test tools/research/execution-crash-20261105/protection.test.mjs tools/research/execution-crash-20261105/replay.test.mjs
node tools/research/execution-crash-20261105/run-study.mjs
```

Um clone limpo precisa receber separadamente o cache públicoCSV nos caminhos do
manifesto antes do replay histórico. CSVs grandes não estão noGit; ausência ou hash
diferente interrompe a execução com o caminho, sem download/reparo automático.
Testes puros/sintéticos não precisam do cache nem de outros estudos. ResultadosF
anteriores, quando presentes, são anexos opcionais e não influenciam certificação.

`results.json` e logs são locais/ignorados. Os hashes de código, datasets,
calibração e resultados completos estão noJSON; `certification.json` resume os
gates e fixa o hash desse resultado. Sem dependências novas, transporte, banco,
variáveis produtivas, cron, servidor, migration ou custo cloud contratado adicional.

## Política candidata e estados

Política registrada antes do replay emPREREGISTRATION.md. Perda5/15/60min:
pisosBTC2/3,5/6%; SOL3/5/9%; limiar efetivo=max(piso,4σprévio×√janela,
quantil99,9% de perdas positivas do ano anterior). O candle de choque não infla
seu próprioσ. Cada moeda possui treino separado. Não recebe spacing, capital,
meta, gain ou número de slots. Esses thresholds são hipóteses, não aprovação.

```text
NORMAL → VOLATILITY_BUY_PAUSED → RECOVERY_CONFIRMING → GRADUAL_RESTART → NORMAL
             ↓ dados inválidos → DATA_PAUSED → nova confirmação contínua
qualquer estado + resultado financeiro incerto → BLOCKED_SAFE somente do engine
```

Retomada exige30–180min adaptados à severidade/σ, continuidade de candles calmos,
perdas inferiores à metade do gatilho, faixa30min limitada e15min sem novo mínimo.
Tempo sozinho não reabre. Dados antigos/gaps reiniciam confirmação. Liquidez
observada ruim dispara; ausência de depth fica explícita e impede certificação
que dependa de liquidez, sem fabricar spread/depth a partir de volume.

O contrato proposto guarda claim sob lease/CAS antes de qualquer dispatch.
BUY NEW/zero-fill/fresca/ownership exato permite somente ONLY_NEW. Fill concorrente
vence. Partial solicita reconciliação/proteção canônica e não cancela automaticamente
o resto de uma posição abaixo do mínimo deTP.503/timeout/crash mantêm claim e
BLOCKED_SAFE, com observação do mesmoorderId/clientOrderId; não há segundoPOST
ouDELETE por hipótese. TP existente é preservado. Estado financeiro calmo não
significa mercado estável, nem mercado estável resolve ambiguidade financeira.

Retorno gera apenas uma intenção de LIMIT prospectiva em referência fresca×(1−spacing)
com o spacing original e novo claim. Não há fila de MARKETs para capturar fundo.
**Não implementado no runtime:** validar/permutar os níveis prospectivos, persistir
o estado/configuração porengine, auditar versão/evento, distinguir pausa no painel
eWatchdog e cobrir todos os caminhos de entrada. Este estudo não autoriza edição
manual de níveis nem altera a políticaMARKET atual da produção.

## Comparação econômica limitada — não é o P&L das contas

Benchmark de execução de grade simplificada, sem meta acumulativa, PRIMARY/RESERVE,
regimeATH, filtros, caps e todos os resets canônicos. Por isso **não certifica a
Strategy Engine**. Mesmos1000 de capital na moeda nativa,25slots, mesmos parâmetros
e custos em cada parA/protegido: BTCspacing2%/gain1,2%; SOLspacing1%/gain5,5%;
fees0,10% por lado; slippageMARKET2bp. Reinvestimento preservado no slot. TP usa a
média do fill×(1+gain bruto), arredondada para cima no tick atual (BTCBRL1,
BTCUSDT0,01/SOLBRL0,1/SOLUSDT0,01). Fees reduzem o líquido, não aumentam o alvo.
LOT_SIZE, filtros históricos e pagamento real de feesBNB não foram reconstruídos.
Configurações são representativas,
nunca alteração dos motoresLIVE. Uma LIMIT residente pode preencher ANTES de o
detector conhecer o fechamento. Isso não pode ser eliminado retrospectivamente.

| Mercado | ComprasA/P | GainsA/P | Retorno líquidoA/P | DDmáxA/P | Pausa total |
|---|---:|---:|---:|---:|---:|
| BTCBRL |246/327|244/324|8,40%/12,12%|10,72%/19,66%|0,20%|
| BTCUSDT |287/363|284/360|8,78%/13,07%|12,11%/12,71%|0,25%|
| SOLBRL |276/312|251/287|-12,39%/-7,41%|94,50%/94,50%|0,23%|
| SOLUSDT |309/394|294/369|35,40%/32,63%|93,97%/93,49%|0,27%|

A reancoragem após pausa pode aumentar compras futuras e exposição; menos compras
no instante do crash não garante menor drawdown global. A comparação é um modelo
de mecanismo e não previsão de lucro ou drawdown dos motores reais. SOL pode consumir todos
os25slots e perder>90% deequity durante bear apesar da pausa. Ganho realizado não
elimina perda em marcação. Esses resultados negativos impedem aprovação econômica.

Foram executados468pares sintéticos: dois ativos×25/50/100slots×spacing1/1,5/2/3/5/8%
×13cenários. Incluem1/3/5/10% em5min,20% em3h,30% em24h,50/70% em1h, quedas
sucessivas por dias,flashV,baixa gradual,lateral ealta. Recuperação emV perde ganhos;
quedas graduais podem ocupar a grade inteira sem volatilidade anormal e **não são
tratadas como erro de spacing**. A exposição original residente pode preencher.
Os contadores completos de compras/TPs/gains/slots/capital/timing ficam emresults.json.

## Certificação e decisão

- Detector e cooldown determinísticos: PASS dasfixtures; mercado real futuro não garantido.
- Cancel/fill/partial/timeout/idempotência/ownership/shards/25–100slots: PASS de modelo.
- PreservaçãoTP e uma intenção de entrada pendente: PASS de modelo, não execução real.
- Revisão independente reproduziu e corrigiu defeitos apenas do protótipo:
  candle que envelhece sem mudar timestamp; claim antigo impedindo novo cancelamento;
  dados infinitos/calibração inválida; relógio de mercado futuro. Regressões cobrem
  validação numérica e booleana estrita, identidade da feature no replay, confirmação
  de uma entrada preparada ainda semACK, eventos antigos idempotentes e IDs especiais.
  Relógio observado é separado do horário do candle; futuro inválido não contamina
  a próxima amostra boa. Nenhuma dessas correções mexeu no runtimeLIVE.
- Economic screen: FAIL. BTCBRL piorou8,95pp de drawdown (limite2pp);
  SOLUSDT perdeu2,78pp de retorno líquido em relação ao baseline (limite−2pp),
  apesar de produzir mais gains. São resultados do modelo, não previsão das contas.
- Runtime/SQL/RLS/transporte financeiro, cadence real, allentrypaths: NÃO TESTADO.
- Depth/spread histórico, cancelamento e latency certificados: AUSENTES.
- ProteçãoLIVE: **DESATIVADA; não integrada; sem caminho de ativação**.

Menor próximo passo técnico seguro, se retomado: integrar configuração defaultOFF
e estado porengine ao único reconciliador, emitir apenas eventosshadow, reproduzir
os caminhos canônicos com banco descartável/transporte simulado e provar isolamento
e TP/ordens residentes; rever política de reancoragem antes de qualquer piloto.
Este estudo não adiciona um segundo motor de decisão financeira.

Correções do próprio benchmark, aplicadas simetricamente antes da conclusão: TP
passou a respeitar gainBRUTO e tick atual depois da revisão do runtime; quando
todas as posições fecham, cancelar a antiga LIMIT do ciclo antes do reset. A primeira
versão deixavaA parado em nível profundo e favoreciaP artificialmente. Floors,
histerese e critérios pré-registrados não foram ajustados para buscarPASS.

## Resultados sintéticos selecionados — modelo SOL, 25 slots, spacing 1%

A/P = baseline/protegido. Pausa é em minutos de candles conhecidos; inclui o período de confirmação.

| Cenário | Compras A/P | Máximo OPEN A/P | Gains A/P | Minutos pausado |
|---|---:|---:|---:|---:|
| DROP1_5 |2/2|2/2|0/0|0|
| DROP3_5 |4/2|4/2|0/0|70|
| DROP5_5 |6/2|6/2|0/0|115|
| DROP10_5 |11/2|11/2|0/0|160|
| DROP20_180 |23/23|23/23|0/0|0|
| DROP30_1440 |25/25|25/25|0/0|0|
| DROP50_60 |25/2|25/2|0/0|205|
| DROP70_60 |25/2|25/2|0/0|210|
| FLASH_V |11/2|4/2|9/0|215|
| SUCCESSIVE_DAYS |25/25|25/25|0/0|0|
| GRADUAL |25/25|25/25|0/0|0|
| SIDEWAYS |10/10|9/9|8/8|0|
| UPTREND |14/14|1/1|13/13|0|

A LIMIT que já estava residente pode preencher antes da pausa. A proteção não desfaz esse fill. Quedas graduais/sucessivas podem consumir todos os slots. São trajetórias sintéticas, não eventos históricos nem estimativa das contas.
