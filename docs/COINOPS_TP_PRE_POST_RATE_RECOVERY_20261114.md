# CoinOps — TP recusado antes do POST por rate limit

## Causa e evidência

Caixeta/SOLBRL, Executor01, engine `c87d9dc2-79f3-448e-aebd-46b44a1397c3`,
run `f600ebf4-7b5d-4ccc-be5c-6317d8342966`. Em14/11/2026 20:55:50 UTC,
o reconciliador confirmou BUY do slot17, 0,027 SOL/R$10,881. Às20:55:56.835,
CREATE_ORDER do TP `C2-b4a273b4d1-17-S-28121fd5503a57` foi recusado com
EXECUTOR_BINANCE_RATE_LIMITED/503. Decisão DISPATCHED, guard presente, sem ACK.
O claim persistiu; Watchdog detectou corretamente SUBMISSION_OUTCOME_UNKNOWN.

O GET exato não encontrou o TP. Essa ausência, isoladamente, NÃO prova não envio.
O source graph8db2cd73/b38d280d foi revisado: naquele runtime CREATE_ORDER pode
emitir esse root somente antes do POST (GET de relógio/safety snapshot). Após
POST, falhas/consultas retornam RESULT_UNKNOWN, ORDER_POST_UNKNOWN ou
ORDER_QUERY_FAILED, nunca esse root. Journal original e processo estável são
exigidos para a compatibilidade histórica; não inferir o upstream429/418.

## Tratamento prospectivo

createOwnedOrder tipa somente rate limit e somente enquanto a barreira
orderPostAttempted permanece false como EXECUTOR_RATE_LIMITED_BEFORE_POST.
O store e servidor existentes usam ExecutorPreDispatchRejection, prova local
de não POST e receipt HMAC vinculada ao corpo/nonce/conta/engine/shard/decisão.
O web verifica assinatura/identidade antes de consumir release/claim sob lease
e CAS pelos RPCs existentes. Não faz retry imediato nem duplica o POST.
O próximo worker normal recupera a mesma ordem e continua a proteção.

Após qualquer POST tentado, timeout ou resultado incerto permanece fail-closed.
Read retry não se estende a create/cancel. A nova capacidade de atestação TP
é publicada separadamente como unsent_tp_recovery_protocol=1; versões antigas
não recebem pedidos SELL de prova. BUY ENTRY mantém seu protocolo anterior.

## Recuperação histórica restrita

O importer root aceita somente o par SHA/fingerprint acima, rate503, SELL/TP,
client/decisão e uma única tentativa exata no journal systemd do PID original.
Prova arquivos do runtime anteriores ao dispatch, pending/hash/mtime estáveis,
ausência de resultado e identidade de engine/shard/IP. Importar antes de restart.
Grava certificado privado, sem alterar pending ou fazer request Binance.

Depois, o endpoint oficial prova ausência durável sob fence, GET Binance exato,
segunda verificação de claim e arquivamento preservando o pending original.
Claim incerto, outra versão, múltiplas tentativas, arquivo alterado, ordem
encontrada, GET falho ou race negam a recuperação. Nunca remover pending à mão.

Reconciliador pede prova apenas para TP PREPARED vazio, decisão CREATE_TP exata
DISPATCHED sem ACK há90s ou mais. Consome receipt sob lease/CAS e despacha a
MESMA identidade com fonte BUY confirmada, quantidade e preço próprios, caps,
saldo físico, ownership e budget normais. Protege primeiro, reconcilia, depois
usa VERIFIED_READ_RECOVERY para abrir só o engine e encerrar o incidente.

## Publicação e verificação

Sem migration/RLS, mudança de regra econômica, capital ou segredo. Atualizar
manifesto com fingerprint Git e SHA completo; janela UTC de duas versões
limitada ao rollout. Import histórico antecede restart, rollout01→02, leitura
financeira e health entre shards, fleet parity no fechamento. Executor03 retirado
não deve ser recriado ou incluído como enabled.

Testes offline cobrem barreira POST, receipt falsa/ausente, claims, fence/race,
import restrito, TP/BUY, isolamento e execução do reconciliador real com
transporte simulado. Nenhuma ordem REAL serve como teste. Production exige
BUY/fills × ledger × TP, NEXT BUY única, slots completos, incidentes e irmãos
saudáveis; os TPs anteriores conservam IDs, preços e quantidades.
