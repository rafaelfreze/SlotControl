# Supabase GET525 — recuperação por motor

CoinOps / OnPlay Platform `otdfpmsegjxpqrzisfmi` / schema `coinops` / REAL.

## Evidência do incidente

28/10/2026 20:35:15Z (16:35:15 Cuiabá), Samya/BTCUSDT, Executor02,
engine `8464c3b3-62ac-4a52-b2f1-c4bf4bd6ed36`, run
`0cf2b890-5bb2-4563-83f0-5a4117562d32`: `COINOPS_LIVE_LEDGER_READ_FAILED`,
stage RECONCILE_ORDERS, GET ledger/slots, HTTP525, tentativa1, sem provider code.
Incidente Watchdog `a2793fdf-e589-4f20-8f0a-09c0a6b79910`, detectado20:35:46Z,
BLOCKED, sem recovery em andamento. Reconciliações posteriores OK/KILL_SWITCH.

Leitura assinada20:40:27Z: 4 posições protegidas por 4 SELL/TP NEW próprios,
0,00045 BTC locked, uma NEXT BUY NEW própria, zero claims pendentes. Não houve
fill/gain associado ao instante do erro. Outros motores tiveram observações
transitórias na mesma janela e convergiram pelo fluxo normal.

525 significa falha de handshake Cloudflare→origem, conforme documentação
oficial: https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-525/
O detalhe interno da infraestrutura do Supabase não está acessível aqui; não
atribuir a certificado, Binance, perda de saldo ou rejeição de ordem sem prova.

## Causa corrigida

O classificador GET reconhecia somente502/503/504 e tratou525 como erro duro,
sem retry. O guard automático excluía READ_FAILED, preservando o bloqueio mesmo
depois da reconciliação. Não era falha de criação/cancelamento de ordem.

- Apenas observeLedgerRows (GET) reconhece525 sem provider code, sob os mesmos
  2 conjuntos completos, 5s e intervalo250ms. Não altera TLS, timeout, cliente de
  ordens, permissões nem a classificação de respostas com provider code.
- Persistência continua usando checkpoint e bloqueio seguro após a janela
  normal; sucesso exige leitura completa/ownership, nunca dado ausente=zero.
- Compatibilidade do incidente antigo é estrita: READ_FAILED/root idênticos,
  HTTP525, GET ledger/slots, LOAD_LEDGER/RECONCILE_ORDERS, 1..2 tentativas,
  provider ausente. Não libera HTTP400/403/526, provider/schema ou erro genérico.
- Resume canônico exige reconciliação, TP/ordens/exposição/meta completos e
  decisões/dispatches assentados duas vezes sob lease. HTTP/provider/tentativas
  entram na identidade imutável do incidente e no CAS final.
- Cron normal recupera; Watchdog valida independentemente o estado e encerra
  o episódio. Nenhum SQL limpa kill switch, incidente ou ordem.

## Regressões e publicação

Fixtures do SDK real reproduzem HTML525, retry completo e exaustão limitada;
perm/schema/526 continuam fechados. Testes de elegibilidade/CAS e resume real
exercitam TP ausente, slots incompletos, decisões/dispatches pendentes que
aparecem tarde, mudança de causa e CAS perdido, sem POST/cancel na exchange.

Mudança só no control plane/web. Regenerar fingerprint financeiro, validar
grafo nativo inalterado, publicar uma vez por Git e aguardar cron oficial.
Não criar recovery alternativo nem provocar ordens LIVE para teste.
