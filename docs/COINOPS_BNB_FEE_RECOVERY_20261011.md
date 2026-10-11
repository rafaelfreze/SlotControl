# Reserva BNB Spot — rejeição pré-POST e recuperação segura

CoinOps · Supabase `otdfpmsegjxpqrzisfmi` · schema `coinops` · REAL.

## Incidente comprovado

Dete/BTCBRL, Executor 02 (`164.90.223.159`), engine
`119e9b7f-7582-4e8f-bd57-c15dc51a4455`, run
`1674ce3e-e514-4286-8cd0-67537763bc1e`.

Em 11/10/2026, o fill Binance do TP do slot físico #5 ocorreu às 15:58:35 UTC;
foi observado/reconciliado às 15:59:26 e gain foi creditado uma vez às
15:59:30. A reentrada passou pelo fluxo normal, mas
CREATE_ORDER às 15:59:56.963 foi rejeitado com
`EXECUTOR_BNB_FEE_RESERVE_MISSING` / HTTP 503 antes de qualquer POST Binance.
BNB livre era 0.00000988, abaixo do guard estrito >0.00001. O erro era
genérico, deixou claim pendente e decisão DISPATCHED sem ACK. Watchdog detectou
`COINOPS_LIVE_SUBMISSION_OUTCOME_UNKNOWN` às 16:00:46, mas corretamente não
presumiu que ausência de BUY comprovava não envio.

O proprietário repôs BNB. Às 16:12:45, BNB Spot livre 0.00900313, quatro TPs
NEW exatos e BTC locked 0.00199; nenhuma BTC BUY residente. Reposição sozinha
não autoriza apagar claim ou repetir ordem.

## Consumo de BNB comprovado por leitura

Ledger e GET Binance concordam em 23/23 fills únicos entre 27/09/2026
18:33:43 UTC e 11/10/2026 15:58:35 UTC, todos com comissão em BNB:

- SOLBRL: 7 BUY, 0.00079944 BNB.
- BTCBRL: 12 BUY, 0.00028901 BNB; 4 SELL, 0.00012804 BNB.
- Total: 0.00121649 BNB. Equivalente histórico registrado pelo ledger:
  R$4.68577959, não uma cobrança adicional em BRL.

O último TP cobrou 0.00004335 BNB. A reposição do proprietário, BUY BNBUSDT
às 16:11:14.208 UTC, trouxe 0.009 BNB bruto menos 0.00000675 BNB de taxa.
Saldo: 0.00000988 + 0.00899325 = 0.00900313 BNB, confirmado às 16:28:22.
Consultas limitadas de Flexible Earn BNB, depósitos, Convert e transferências
Spot↔Funding não mostraram movimentos BNB entre 24/09 e 11/10. Isso não
reconstrói o saldo inicial nem toda
movimentação externa histórica. Não afirmar que taxas explicam integralmente
o saldo quase zerado sem comprovar também a compra/reserva anterior.

## Correção comum

- Observar reserva física BNB e preço BNB da moeda correta, frescos até 30s,
  antes de preparar, cancelar NEXT BUY própria ou despachar uma BUY.
- Insuficiência conhecida produz HOLD/AVAILABLE por engine/run somente nas
  transições. Não reduz threshold, qty/capital, spacing, gain, meta ou TP.
  TP, fills e reconciliação continuam; não comprar/converter BNB.
- Leitura ausente, inválida ou stale continua fail-closed, nunca saldo zero
  inventado ou prova de não envio. O checkpoint persistente `BNB_FEE_READ`
  preserva o relógio de 5min enquanto TP/fills continuam; uma leitura válida,
  não uma reconciliação parcial, resolve esse checkpoint. Outage persistente
  usa somente o gate de entradas do engine e exige prova BNB fresca no resume.
- O executor preserva guard >0.00001; rejeição comprovada pré-POST é tipada.
  Receipt HMAC exige classe, código/status permitidos, POST não iniciado,
  body/nonce/engine/account/shard exatos. 503/timeout genéricos não recebem
  retry financeiro ou prova assinada.
- SQL existente libera uma decisão somente sob lease e receipt válida;
  identidade, guard e histórico permanecem. Retomada passa reconciliação,
  TP/caps/configuração, incidente inalterado e CAS pelo fluxo oficial.

## Compatibilidade histórica limitada

O importer root aceita apenas pares explícitos de runtime/fingerprint/código.
Este caso usa runtime `bc43636bfd96cbb3618a7380c86e0d7f61f8b9fd`, fingerprint
`9ac54825d53da6ed250c904a1c232e07b64643460c4aa99308dba4b16b2dd963` e
BNB503. O caso QUOTE403 anterior permanece separado, sem allow-all.

Importar antes de restart: PID real estável, arquivos do grafo anteriores ao
dispatch, journal systemd daquele PID, única tentativa exata, scope/hash,
timestamp e claim privado inalterados. Import grava somente certificado HMAC
0600; não imprime secret nem remove pending. O reconciliador instala fence,
faz GET exato, revalida contra race e arquiva o original. Qualquer dúvida
mantém bloqueio somente no engine afetado.

## Publicação e validação

Sem migration ou alteração de credenciais. Relatórios v23 exportam
`physical_spot_bnb_fee_reserve` e HOLD/AVAILABLE, sem tratá-los como fill/gain.
Release comum exige publicação web e rollout sequencial 01 → 02 → 03;
confirmar LIVE, reconciliação, OPEN/TP/NEXT BUY, incidentes e Watchdog antes
e depois de cada restart, somente um serviço/executor por vez.

Não testar trades em Production. Fixtures cobrem pré-POST, erro falso,
assinatura/nonce/escopo, snapshot stale, insuficiência/reposição, preservação
de BUY residente/TP, mesmo símbolo/outro shard, claim/journal alterado e
archive sem exclusão. Fechamento exige verdade Binance × ledger × engine,
reconciliation recente e FLEET_PARITY 3/3, não apenas deploy READY.
