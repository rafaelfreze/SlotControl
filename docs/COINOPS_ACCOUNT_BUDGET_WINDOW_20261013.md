# Dete/BTCBRL — janela ORDERS e retry de observação

CoinOps · REAL · Supabase `otdfpmsegjxpqrzisfmi` · schema `coinops`.
Escopo: conta Dete, engine `119e9b7f-7582-4e8f-bd57-c15dc51a4455`,
run `1674ce3e-e514-4286-8cd0-67537763bc1e`, Executor 02 `164.90.223.159`.

## Incidente e verdade atual

Em 13/10/2026, o fill da BUY do slot físico #5 foi reconciliado às
11:04:26.857 UTC. O TP foi confirmado às 11:04:38.506. A preparação da
NEXT BUY #6 preservou a identidade original, mas a coleta de orçamento
account-global não forneceu amostra aceita para dispatch naquele tick.
Alerta WARNING `16605e69-ad32-4e44-9aaa-901286e2f14b`,
`COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN`, aberto às 11:05:07.821 UTC;
push aceito às 11:06:02.249 UTC (07:06:02 America/Campo_Grande).

O próprio cron LIVE recolheu nova amostra válida às 11:06:30.261 UTC,
reservou o orçamento às 11:06:31.651 e enviou a única NEXT BUY às
11:06:33.552. ACK às 11:06:36.569; alerta resolvido automaticamente às
11:06:44.517. Não houve kill switch nem incidente crítico novo.
Watchdog permaneceu HEALTHY; esta recuperação é do fluxo normal, não dele.

Às 11:14:23.286 UTC, GET oficial no shard proprietário confirmou:

- health, permissão SPOT_RESTRICTED, IP e runtime `8dc5eb4` corretos;
- cinco TPs Binance NEW, quantidade total 0,00252 BTC = BTC locked;
- NEXT BUY única `2356800664`, clientOrderId
  `C2-f040b326a6-6-B-044a3b9002a846`, 0,00055 BTC a 407725 BRL, zero fill;
- IDs, lado, preço, quantidade e execução coincidentes com ledger;
- 25 slots físicos, cinco OPEN, slot #6 ARMED, demais PLANNED;
- BNB livre 0,00814708 e BRL livre 10354,12642579: não foi falta de BNB/caixa.

Os quatro TPs anteriores `2346270639`, `2347163989`, `2347246538`,
`2349238089` permaneceram. O novo TP #5 é `2356798171`.
Nenhuma ordem foi criada, cancelada ou substituída manualmente na manutenção.

## Defeito de agendamento e limite da causa histórica

Journal sanitizado do Executor 02:

| Fim UTC | HTTP executor | Duração | Resultado |
| --- | --- | --- | --- |
| 11:04:50.598 | 503 | 1534 ms | EXECUTOR_ACCOUNT_ORDER_BUDGET_UNKNOWN |
| 11:04:59.116 | 200 | 2322 ms | READ_ONLY_ACCOUNT_ORDER_BUDGET |
| 11:05:07.661 | 200 | 2334 ms | READ_ONLY_ACCOUNT_ORDER_BUDGET |
| 11:06:31.460 | 200 | 1544 ms | READ_ONLY_ACCOUNT_ORDER_BUDGET |

A amostra assinada da retomada confirma intervalos Binance ORDERS de
10000 ms e 86400000 ms. As leituras HTTP 200 anteriores terminaram perto de
limites UTC de 10s, em sequência compatível com perda de margem. Porém,
observedAt, offset e razão exatos dessas tentativas não foram persistidos.
Fim HTTP sozinho não prova a margem no relógio Binance: um offset positivo
pode colocar a observação na janela seguinte. Não afirmar qual validação ou
fase falhou historicamente, nem uma causa upstream adicional.

O replay sintético desses tempos com offset zero comprova o defeito possível:
cooldown fixo de 5500 ms recoloca o probe no fim da janela e consome as três
tentativas sem amostra utilizável. O ajuste usa os valores assinados reais de
cada nova observação, não a hipótese zero-offset desta reconstrução.

O 503 inicial é do executor. Seu código antigo não conserva a fase upstream:
não afirmar que foi 503 da Binance, permissão, saturação ou timeout.
Esta correção elimina o defeito reproduzido de agendamento após uma amostra
integral válida sem margem; não transforma qualquer 503 em autorização.

## Correção e guardas

Somente depois da validação integral da observação, uma amostra expirada ou
sem margem pode alinhar o retry ao início da primeira janela curta original
compatível com o cooldown mínimo de 5500 ms, derivada de serverTime e offset.
Descarta a amostra anterior e consulta novamente: não presume reset de count,
não estende validade, não soma budgets por IP e não repete ordem financeira.

Permanecem até três leituras, deadline total 35s, margem de dispatch 4000 ms,
freshness original 30s, lease account-global e release por CAS. Falha sem
amostra integral validada mantém a política anterior; schema/ownership/flags
inválidos, banco, rate limit e ambiguidades continuam fechados. Sem tempo
para nova janela, deferir ao próximo tick normal, nunca ampliar prazo.

Publicação somente web. Sem migration, secret, cron adicional, mudança de
estratégia, runtime VPS ou restart. Regra técnica exportada em RULES.csv/JSON
como `account_order_budget_window_retry`; o formato de relatório v23 permanece.

## Regressão e resposta operacional

Harness usa relógio, DB e transport sintéticos, sem Supabase/Binance LIVE.
Reproduzir a sequência de latências acima, offset, virada diária, latência de
persistência, deadline insuficiente, três falhas, escopo inválido e lease de
outro worker. Nunca criar trade para comprovar o fix.

Se a janela validada continuar insuficiente, erro tipado preserva somente
WINDOW_MARGIN/WINDOW_EXPIRED, fase, tentativas e margem nos eventos/alertas.
Falhas genéricas continuam sem causa presumida. Assim, uma recorrência futura
tem evidência que não existia neste episódio; não preencher histórico.

Validação local final: 71/71 regressões dirigidas de coleta, offset/deadline,
evidência tipada, ownership/HMAC, account limits, criação idempotente, ativação,
recuperação e observação normais, Watchdog e exportação PASS. Revisão
independente e typecheck/lint/build final isolado PASS. O primeiro build
sandbox encontrou EPERM de filesystem; o final usou outro diretório e
completou. Avisos já existentes de CSS/Supabase Edge não foram alterados.
Fixtures não fazem chamadas de produção. Deploy/smoke devem ser confirmados
no fechamento; a sequência sintética não prova ausência de qualquer falha
futura de provider/infraestrutura.

Em recorrência: ler push e alerta exatos; se já resolvido, conferir uma única
ordem/ACK e reconciliação. Se saudável, não interferir. Se persistir, coletar
apenas logs da janela e evidência por account/engine/shard; não limpar gate,
forçar capacity, estender sample ou repetir clientOrderId por suposição.
Referência: `COINOPS_ACCOUNT_BUDGET_PROBE_RECOVERY.md`.
