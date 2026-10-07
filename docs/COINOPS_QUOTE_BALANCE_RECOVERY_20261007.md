# Saldo físico Spot e recuperação de rejeição pré-POST

## Incidente e causa comprovada

2026-10-07, Jenny Mae Maria / SOLBRL / executor-02 (164.90.223.159).
Engine `755cf77f-a517-4c84-ac4b-6ee041ed1123`, run
`3f09a415-8fc8-4d7e-908a-7cdca58b4929`. Após fill do slot 3 e TP
residente, a entrada do slot 4 precisava de 10.678 BRL (0.019 × 562).
Spot livre observado era 0.0043 BRL; depois foi observado 300.0043 BRL.
Não há prova da transferência para Earn; é hipótese do proprietário.

O journal em 13:39:47.193Z registra CREATE_ORDER recusado com
EXECUTOR_QUOTE_BALANCE_INSUFFICIENT / 403, antes de Binance POST no runtime
65f2e382a441d5c51509d06a17e6ddfe74cef60c. A exceção genérica deixou claim
pendente e decisão DISPATCHED. GET sem ordem não bastava para liberar.
O protocolo antigo também exigia política de orçamento multi-engine, ausente
nesta conta legada. Watchdog detectou, mas corretamente não adivinhou não envio.
Três TPs somavam 0.053 SOL, exatamente o saldo locked observado; nenhum foi
cancelado/substituído nesta manutenção.

## Regra comum, sem alterar estratégia

Antes de preparar/guardar/despachar BUY, validar snapshot Spot ≤30s e moeda
correta. Saldo desconhecido continua fail-closed. Insuficiência gera WARNING
e eventos ENTRY_QUOTE_BALANCE_HOLD/AVAILABLE somente nas transições, mantendo
TP, fills e reconciliação. Não reduzir quantidade/preço/capital. Reposição
retoma pelo fluxo normal; não por render/poll extra. Cancelamento de BUY
residente só pode recuperar notional da ordem própria exata, sem fill.

O executor emite NOT_SUBMITTED assinado somente para rejeição comprovada
antes do POST; o transporte exige HMAC, nonce, hash e escopo exatos. A liberação
SQL existente continua sob lease. Timeout/POST ambíguo nunca vira tal prova.
Atestação de não envio é independente da política de orçamento; despacho
continua exigindo todos os gates de orçamento/capacidade/ownership.

## Compatibilidade histórica restrita

`apps/live-executor/deploy/import-pre-dispatch-rejection.mjs` é manutenção root
obtida de GitHub/main + SHA explícito, não ferramenta normal de trading.
Antes do restart, conferir PID real, SHA e fingerprint fixados, arquivos
inalterados desde antes do dispatch, registry e escopo, journal systemd do PID,
uma única recusa exata com timestamp e request/idempotency/decision/engine.
Sem evidência completa: parar; nunca remover `.pending` manualmente.

Argumentos: shard, IP, engine_id, clientOrderId, decision_id, dispatched_at, PID.
O import grava somente certificado HMAC privado 0600 junto ao claim, mantendo
o original; não faz request Binance nem modifica registry/credenciais/ledger.
O reconciliador oficial depois valida assinatura/claim, fence durável, GET da
identidade exata, segunda verificação contra race, e arquiva o claim original.
Somente a receipt assinada pode ser consumida pelo RPC existente sob lease.
Novo POST preserva clientOrderId/decisão e passa todos os gates novamente.

Prova histórica não se aplica a outro runtime, claim alterado, múltiplas
tentativas, timeout, POST incerto, ordem encontrada, completed claim ou outro
engine/shard. Falha permanece no menor escopo; nenhum kill switch global.

## Publicação e fechamento

Relatórios v19 exportam regra e eventos, sem afirmar que receipt é fill.
Sem migration nova. Release comum exige rollout sequencial e FLEET_PARITY 3/3.
Antes/depois de cada restart: saúde, engines, TP, NEXT BUY, fills pendentes,
reconciliação, incidentes e Watchdog. Não reiniciar dois shards simultaneamente.
Validar saldo Spot × ledger × engine, três TPs originais, uma NEXT BUY própria,
25 slots, reconciliação recente e resolução pelo fluxo oficial. Não limpar
incidente/kill por SQL. Testes são fixtures offline, nunca LIVE artificial.

Regressões: saldo insuficiente/reposto, BRL/USDT, BTC/SOL, initial/NEXT BUY,
claim ambíguo, assinatura falsa, runtime divergente, GET falhando/com ordem,
claim concorrente, isolamento de engine/shard e preservação do arquivo original.
