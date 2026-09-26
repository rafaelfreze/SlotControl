# CoinOps Automation — Capacity Manager

CoinOps é Automation-first: Production/LIVE, Testnet de validação, ADMIN,
VIEWER, Strategy Engine, executor(es), ledger, recovery e observabilidade.
Operação manual antiga não é produto ativo. Migrations e histórico legado
continuam imutáveis e legíveis para auditoria.

## Escopo e isolamento

`account → engine → job/lock → reconciliation → alert → kill switch` tem
identidade explícita. Uma falha local bloqueia somente o motor/conta
correspondente. O Capacity Manager é plano de controle: apenas novas
ativações dependem dele. Falha da coleta **nunca** pausa, cancela, reprifica
ou reancora motor LIVE. Cada conta possui um `executor_shard_id` primário;
nenhuma migração de conta/IP ocorre automaticamente.

## Medição e política inicial

O executor registra os cabeçalhos IP-wide `x-mbx-used-weight-1m` das respostas
Binance Production já necessárias para a operação, sem criar novas leituras.
Publica via rota HMAC `/v1/capacity` o atual, média e pico por minuto nos
últimos 15 minutos, CPU do processo, RSS, RAM do host, heartbeat e contagem
de contas/motores. O cron server-side `/api/cron/coinops-capacity` coleta a
cada minuto, confronta a registry com o ledger e persiste backlog, idade de
reconciliação, erros HTTP/rede Binance, tentativas repetidas prováveis e versão.
Tentativas repetidas são estimadas por método/rota após falha em até 3 segundos;
não representam contagem exata de retries internos do adapter. Navegador e Codex
não participam da coleta.

Base observada na auditoria: 4 contas/7 motores, CPU VPS ~4,9% de um núcleo,
executor ~147 MB e peso Binance médio ~3.614/min, pico ~3.628/min, com
minutos de ~2.258–2.668/min. O limite observado/documentado era 6.000/min.
Esses números incluíram atividade de auditoria, não são custo marginal nem
prova de capacidade para 50 contas. O custo incremental inicial conservador
é 900 weight/min por motor; deve ser substituído por medição p95 de novas
contas em carga normal antes de ampliar admissões.

Thresholds configuráveis: `<50%` HEALTHY, `50–65%` OBSERVE, `65–75%`
WARNING/preparar SCALE_OUT, `>=75%` CAPACITY_LIMIT. Novas ativações só
passam quando o **pico de 15 min + reservas de admissões pendentes + 900 por
motor** fica em até 65% do limite. A reserva de 35% protege recuperação e
leituras simultâneas. Acima de 70% CPU, 75% RAM, backlog ou p95 de
reconciliação >=120 s, a admissão também bloqueia. Telemetria/heartbeat/
weight com mais de 120 s, menos de 2 minutos amostrados, registry divergente
ou Capacity Manager indisponível = CAPACITY_UNKNOWN, fail-closed apenas para
nova ativação. A reserva SQL serializada por shard dura 20 min; replay do
mesmo motor não duplica a cobrança.

SCALE_OUT é indicado por peso Binance/IP: novo executor com IP fixo próprio,
health e whitelist explícita, então novas contas atribuídas a ele. Não usar
rotação de IP para burlar limites. SCALE_UP só se CPU/RAM medidos forem o
gargalo. Não criar infraestrutura cobrável antecipadamente.

## Fluxo e segurança

Preview sem ordem retorna CAPACITY_OK/REQUIRED/UNKNOWN. PROVISION permanece
INACTIVE sem ordem, e ACTIVATE revalida capacidade em RPC atômica antes de
abrir o run. Não muda a lógica da Strategy Engine ou o tratamento de TP/BUY.
ADMIN vê o card de infraestrutura; VIEWER não acessa a rota. Alertas por shard
`BINANCE_WEIGHT_WARNING`, `EXECUTOR_CAPACITY_WARNING`, `CAPACITY_LIMIT`
reutilizam subscriptions de operador, com incidente e entrega deduplicados.
Push nunca contém segredo/credential_ref nem cria operação.

Ordem segura de publicação: validar migration em PostgreSQL descartável;
confirmar backend/schema/estado LIVE; aplicar migration aditiva; instalar
executor com rota de telemetria e confirmar HMAC/health; publicar web/cron;
aguardar duas amostras de minuto e comprovar card, admissão e push, sempre
sem criar ordem para smoke. Se o acesso ao VPS faltar, não declarar os gates
ativos nem publicar UI/gate parcialmente.

Gates só podem ser afirmados com evidência pós-deploy:
`CAPACITY_TELEMETRY_ACTIVE`, `ADMISSION_GATE_ACTIVE`,
`CAPACITY_ALERTS_ACTIVE`, `EXISTING_ENGINES_UNAFFECTED` e
`MULTI_ACCOUNT_ISOLATION_ENFORCED`.
