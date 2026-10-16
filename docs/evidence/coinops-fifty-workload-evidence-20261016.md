# CoinOps — revisão dirigida de workload50,16/10/2026

## Decisão

**Não emitir certificado `SLOT_WORKLOAD_V1` para50slots nesta evidência.**
Os testes funcionais abaixo passaram, mas não demonstram um limite completo
por minuto para o fluxo ACTIVE. A reprodução de componentes descrita abaixo
contou2816 de peso REST em uma cadeia sintética inferior a60s, acima dos2700
correspondentes a três unidades conservadoras. Isso **não é medição de consumo
Binance/Production por minuto**. Também não certifica quatro unidades: faltam
limite superior completo, agenda, retries combinados e os sete cenários exigidos.

Nenhum perfil com sete `PASS`, `capacity_units` ou limite superior foi fabricado.
Nenhuma certificação, motor, ordem ou configuração foi escrita em Production
por estes testes. O gate canônico permanece necessário e independente do saldo,
dos filtros e do pouco uso atual do Executor03.

## Alvo exato e fontes

- Thyely, novo engine independente SOLBRL no Executor03.
-50slots, R$22 iniciais por slot, R$1100 de capital.
- Gain3%, meta3gains/slot/mês, spacing normal2%, pós-ATH3%.
- Código-base revisado: `f82e134084c67b424809c586a3b7b4cd46e00489`.
- Quantidade50 é testada diretamente; não foi deduzida por `50/25`, nem pelo
  perfil100 ou por uma amostra de baixa utilização.

Pesos de endpoints consultados na documentação oficial em16/10/2026:
[Spot Account REST](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account),
[General REST](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/general),
[Market REST](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market).
`rateLimit/order` e `myFilters` custam40; `openOrders` custa6 por símbolo ou80
sem símbolo; consulta de ordem4; `myTrades` com `orderId`5.

Os hosts `api.binance.com` e `data-api.binance.vision` são discriminados no
inventário, mas seus pesos são somados conservadoramente para o mesmo IP.
Não há nesta entrega prova de quotas independentes por esses hosts.

Verificação dirigida adicional: o [REST Spot oficial, IP Limits](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#ip-limits)
define o contador por IP e o header `X-MBX-USED-WEIGHT-*`; a página oficial
[Market Data Only](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md)
descreve as rotas públicas de `data-api.binance.vision`, mas nenhuma das duas
afirma explicitamente que esse host possui um bucket independente.
No código atual, `apps/live-executor/src/capacity-telemetry.mjs`, linhas5 e19–23,
o recorder REAL aceita somente respostas de `api.binance.com` com
`x-mbx-used-weight-1m`; `server.mjs`, linhas76–77, instala esse wrapper de fetch.
O teste existente `capacity-telemetry.test.mjs`, linhas99–105, confirma que
headers do host público são ignorados. Isso não comprova um bug nem separação
de quotas: se o header privado for global, pode incluir o tráfego público;
se houver buckets separados, seria necessário prová-los e observá-los.
Por isso os740pesos públicos do trace não são descartados para certificar50.

## Testes efetivamente executados

`tools/testing/fifty-slot-workload.test.mjs`: **6/6 PASS**.
`tools/testing/hundred-cycle-continuation.test.mjs`: **2/2 PASS**, regressão após
export/guard mínimo do helper compartilhado. O comando conjunto terminou8/8.
`git diff --check` nos dois arquivos: sem erro; somente aviso Windows de EOL.

Comando reproduzível, da raiz do checkout:

```powershell
node --experimental-strip-types --test tools/testing/fifty-slot-workload.test.mjs tools/testing/hundred-cycle-continuation.test.mjs
```

As dependências são as já existentes no repositório. Não há leitura de `.env`,
vault, banco remoto ou rede externa. O banco é PGlite em memória. Os POSTs da
fixture são respostas em memória dentro do `fetcher`, não ordens Binance.

### Prova financeira50

O harness parametrizado executa reconciliação/crédito canônicos e SQL versionado:

1.50TPs FILLED reconciliados e50gains creditados uma vez.
2. `recycleClosedSlots` real distingue GLOBAL_RESET de reentrada local.
3. `restartClosedCycle` real e RPC SQL real criam um sucessor único com50slots.
   Replay do RPC retorna o mesmo sucessor.
4. Planners, `prepareOrder`, `updateSlot` e SQL de prepare/sync reais processam
   primeira BUY FILLED, comissão BNB, TP NEW e exatamente uma NEXT BUY NEW.
5. Replay preserva três ordens, uma posição OPEN, um slot ARMED e efeitos
   financeiros únicos. Gain/spacing e configuração50 permanecem os solicitados.
6. Contas de slots e engine irmão25 da mesma conta permanecem intactos.

O preço/ATH e a consulta de ranking mensal são fronteiras de fixture; os planners
e o ranking são canônicos. Os ACKs de primeira BUY/TP/NEXT são sintéticos passados
ao SQL, não o despacho financeiro completo pelo executor. Isso prova integridade
local, não latência ou capacidade de Production.

Os sete testes financeiros adicionais de50 do outro harness constam no artefato
`coinops-fifty-fill-directed-tests-20261016.md`; não são automaticamente uma
certificação de capacidade.

### Inventário de componentes nativos

`BinanceLiveTransport` e o leitor account-global são os módulos reais, com
`fetcher` simulado e credenciais exclusivamente fictícias.

| Componente efetivamente executado | Total | api.binance.com | data-api.binance.vision |
| --- | ---: | ---: | ---: |
| Snapshot fresco |54|30|24|
| Snapshot com primeira leitura de permissão503 e segunda válida |106|58|48|
|50ordens: consulta+confirmações+trades, sem snapshots |950|950|0|
| Budget completo dos três mercados, sem filtro exchange-wide |199|179|20|
| Budget completo dos três mercados, com filtro exchange-wide |261|241|20|

Os três mercados considerados são BTCUSDT, SOLUSDT e SOLBRL. A coleta não ignora
os motores antigos por estarem em outro shard. Vinte probes concorrentes da
mesma conta/chave/mercados convergiram em um único probe. Três tentativas completas
custariam597/783, respectivamente; isso é um envelope de componentes, não prova
de que todas ocorrem no mesmo minuto de um fluxo completo.

## Reprodução que impede assinar três unidades por inventário parcial

Teste: `EXACT_50_MIXED_ACTIVE_NATIVE_CALL_TRACE`.

Estado sintético:25TPs FILLED,24TPs PARTIALLY_FILLED e uma BUY residente FILLED.
Os25SELLs terminais não satisfazem o predicado atual `>25` do checkpoint precoce.
Há TP para proteger a BUY nova; os25slots encerrados podem ser reciclados.
O preço observado501 torna a reentrada a500 ainda não atravessada. O planner
canônico escolhe uma única NEXT BUY; a fixture simula fill a500 e então cria TP.
Não há BUY retroativa, mudança do spacing ou segundo engine de estratégia.

Hipótese explícita de falha: cada um dos15snapshots sofre um503 na primeira
leitura GET de permissões e passa na segunda. O transporte permite essas
repetições internas independentemente do pool de três retries externos web.
Essa não é afirmação de frequência ou comportamento histórico da Binance.

| Cadeia de chamadas nativas composta ao longo do ramo ACTIVE | Peso total |
| --- | ---: |
| Seis snapshots de estado externos aos três reconciles de criação |636|
|49SELLs+1BUY observadas com suas confirmações/trades |950|
| Um probe account-global fresco, três mercados, sucesso inicial |199|
| Primeiro TP: query, estado web, create com safety própria, trades, cotação |345|
| NEXT BUY: mesmas etapas, sem sourceBUY de SELL |341|
| TP que protege o fill da NEXT BUY |345|
| **Total de componentes** |**2816**|

Resultado da execução conjunta de referência:

-572requests simuladas;3POSTs financeiros em memória, nunca repetidos.
-2076peso em `api.binance.com`;740em `data-api.binance.vision`.
-15falhas iniciais de permissão;30chamadas de permissões ao todo.
-Zero dos três retries externos consumidos; budget passou na primeira tentativa.
-140,317ms de parede do trecho de transporte,125ms CPU user+15ms system.
- RSS antes511475712bytes, depois514871296; pico do processo1184251904bytes.
  Esses valores pertencem ao processo de teste após PGlite, **não ao VPS03**,
  nem isolam o custo incremental do transportador.

O teste imprime23fases com offsets de início/fim e contagem/peso por fase, para
que a cadeia seja reproduzível. Tempos são da fixture local sem latência externa;
não provam throughput da Binance nem latência Supabase/Vercel. Também não executa
`advanceLiveRun` inteiro: compõe as chamadas nativas dos seus caminhos e comprova
o financeiro em teste SQL separado. Portanto2816 é um contraexemplo ao inventário
incompleto950, **não um upper bound completo do engine**.

## Economia tecnicamente segura a investigar posteriormente

No ramo acima, `reconcileOrder` sem contexto BNB ainda lê um estado completo
apenas para cotar a taxa, mesmo quando a lista de trades do TP NEW é vazia.

- Pular cotação quando não existe nenhum trade com comissão denominada em BNB elimina dois snapshots
  nessa cadeia:212peso com as falhas simuladas;2816→2604.
  Comissão BNB igual a zero continua exigindo cotação pelo SQL canônico; não
  usar `commission > 0` para decidir essa condição.
- Reutilizar exclusivamente a cotação BNB fresca do estado pré-POST, com escopo
  canônico e TTL60s, pode retirar também a cotação do fill BUY: mais106;
  total de componentes2498.
- Não reutilizar saldo, filtros, permissões ou openOrders para autorizar outra
  ordem. Um contexto econômico nunca é autorização financeira.
- Mesmo essa economia não prova três unidades: três retries externos de estado
  podem repor até318neste inventário, e duas tentativas extras do budget completo
  acrescentariam398sem filtro global.2498+318+398=3214, ainda sem provar agenda,
  successor ou outros caminhos. Essa soma é sensibilidade conservadora, não
  consumo medido ou certificado de quatro unidades.

Não foram alterados runtime, frequência, proteção, gate ou política para forçar
o motor a caber. A alternativa posterior é um teste completo e instrumentado
do fluxo ACTIVE, com clocks e limites reais dos retries/agenda, seguido apenas
das eliminações de leituras econômicas redundantes comprovadas. Após isso, emitir
perfil exato50 com os sete cenários somente se o limite superior for demonstrado,
mesmo que o resultado legítimo seja Admission FAIL.

**NENHUMA ALTERAÇÃO LIVE REALIZADA POR ESTA REVISÃO.**
