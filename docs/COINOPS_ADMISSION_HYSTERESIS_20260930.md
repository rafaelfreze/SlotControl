# Admission Gate v3 — pressão sustentada e histerese

Produto CoinOps; Supabase `otdfpmsegjxpqrzisfmi`, schema `coinops`.
Mudança exclusiva no control plane: não modifica estratégia, contas, motores,
ordens, TP, NEXT BUY, vault, credenciais ou runtime dos executores.

## Causa e evidência anterior à mudança

A v2 usava `max(atual, média, pico15m) + pendentes + 900*N <=3900`.
Um pico isolado contaminava o orçamento durante 15 minutos; sua expiração
reabria imediatamente. Não havia memória temporal da decisão.

Leitura server-side 2026-09-30 13:25:51 UTC:

| Shard | Motores | Atual | Média 15m | Pico 15m | Projeção v2 +1 | Projeção sustentada +1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| executor-01 | 7 | 2272 | 2414,50 | 3187 | 4087 (68,12%, NÃO) | 3314,50 (55,24%) |
| executor-02 | 6 | 1946 | 2140,19 | 3034 | 3934 (65,57%, NÃO) | 3040,19 (50,67%) |

Sem backlog, erros/retries recentes ou divergência de registry. CPU ~2%,
RSS ~143/150 MB em hosts ~961 MB; reconciliação ~26s; Watchdog 7+6 saudáveis.
Na auditoria anterior 02:23 UTC, os picos 2673/2473 projetavam +1 em
3573/3373: SIM. Às 13:57:42 UTC, já expirados os picos, v2 voltou a SIM:
projeções 3177/2875. O número de motores permaneceu 13; não houve
evidência de saturação sustentada que justificasse os vetos de 13:25.

Comparação read-only de journals em duas janelas iguais de 15 min:
29/09 20:39–20:54 UTC versus 30/09 13:49–14:04 UTC. Executor 01:
READ_STATE 707→533, QUERY_ORDER 300→300, CAPACITY_READ 15→15.
Executor 02: READ_STATE 582→463, QUERY_ORDER 240→240, CAPACITY_READ 15→15.
Não houve READ_TRADES, READ_RECONCILIATION ou ACCOUNT_SNAPSHOT nessas janelas.
O rótulo antigo DENIED inclui `/v1/health` com HTTP 200/HEALTHY: 434→133
no 01 e 372→114 no 02; não significa recusa de uma ordem. Os HTTP 404
EXECUTOR_ROUTE_DENIED foram 4→1 e 4→2, sem evidência de erro Binance.
Essas contagens não são custo weight por rota nem prova estatística longa,
mas não indicam aumento por UI/Health/Watchdog recente. O GET de capacity
e o Watchdog saudável usam DB; Saúde do Ativo usa probes públicos limitados
no IP da Vercel; FinOps capital mantém cooldown e não coleta por render.

## Política única e matemática

`executor_capacity_policy()` versiona `capacity-v3-20260930` para todos os shards.
`preview_executor_admission` continua a autoridade de preview, ASSIGN e reserva
serializada. Não se usa classificação UI para autorizar uma ativação.

- Peso sustentado = média dos máximos registrados por minuto UTC na janela de
  15 minutos do executor. Exigir pelo menos 15 amostras; não usar média de
  counters crus que voltam a zero a cada minuto.
- `projeção_N = média15m + reservas ainda não observadas + 900*N`.
- Teto normal 3900 = 65% de 6000; recovery 2100 = 35%, descontado uma vez.
  Reservas idempotentes são consumidas quando o motor aparece na telemetria
  fresca coincidente com registry. Replay exclui a própria reserva.
- Aberto: permanece SIM enquanto projeção sustentada <=3900 e demais gates
  seguros. Fecha ao ultrapassar 3900. A média já exige uma janela de pressão:
  não adicionamos atraso ao fechamento que permitiria gastar recovery.
- Fechado/inicial/gap: exigir projeção <=3600 (60%) durante 600 segundos de
  observações contínuas frescas para reabrir. Banda morta de 300 weight/min
  impede alternância ao redor de 3900. Gap >120s ou mudança de política
  reinicia o período saudável; replay/fora de ordem não soma tempo.
- Emergência: atual >=4500 (75%) ou atual + reservas +900*N >=5400 (90%)
  veta imediatamente mesmo com média baixa. Pico histórico não é emergência
  atual. Não relaxamos headroom, CPU >=70%, RAM >=75%, backlog, reconciliação
  >=120s, erros/retries, freshness, runtime, registry ou Watchdog.

Os 15 minutos são a janela já medida em produção; a abertura usa 10 minutos
(10 coletas consecutivas normais) e margem extra de 300 para não reabrir no
limiar. São parâmetros conservadores de política, não um p95 estatístico
inventado. Incremento 900 continua `CONSERVATIVE_UNCALIBRATED`.

HEALTHY: pressão abaixo de 50%. OBSERVE: pressão/pico >=50%, sem condição
sustentada WARNING ou crítica; pode coexistir com +1 SIM. WARNING: média
>=65% ou problema operacional. CAPACITY_LIMIT: atual/média >=75%.
OFFLINE preserva o estado operacional de evidência ausente. +1/+2 são
decisões independentes, exibidas com motivo matemático e tempo de recuperação.

## Persistência, segurança e futuros shards

Triggers sobre as duas tabelas de samples existentes avançam
`executor_admission_hysteresis` somente por nova coleta. Não criam cron,
requisição Binance nem deploy de executor. Estado por shard/ambiente/+N,
chave primária e lock por linha; 1..25 é o contrato de entrada existente,
não limite de motores de um servidor. Novos shards entram automaticamente.

`executor_capacity_observations` conserva 24h; transições ficam append-only em
`executor_admission_transitions`. Tabelas com RLS FORCE, grants somente
service_role e funções invoker/search_path vazio; ADMIN lê pelo backend
autenticado. GET/export JSON de capacity expõe motivos, métricas, política,
amostra e última transição, mas nunca secrets. Relatórios financeiros v14
não mudam: nenhuma semântica de slot/ordem/trading é alterada.

A migration revisa somente a versão de política em certificações já válidas
que coincidem com SHA/fingerprint/Node/IP/defaults comuns, preservando
`verified_at` e evidência original. Não certifica shard faltante nem inventa
runtime rollout. O coletor precisa acumular os 10 minutos reais após upgrade;
nunca preencher history/healthy_since artificialmente em Production.

## Verificação

Regressão PostgreSQL 17 local descartável, nunca Supabase vinculado:
`COINOPS_AUDIT_PG_BIN` aponta aos binários locais; em `apps/web`, executar
`node --experimental-strip-types --test lib/coinops-capacity/canonical-admission-sql.test.ts`.
22 casos, incluindo baseline v2 e upgrade v3: pico/expiração, pressão
sustentada, recovery/deadband, atual 4500/5900, projeção crítica, replay,
reload, freshness, recursos, erros, reservas reais/idempotência/concorrência,
01/02/futuro03, REAL/Testnet, RLS e estado de conta preservado. Injeção de
tempo existe apenas na fixture descartável; não é procedimento operacional.

Após migration e push, comparar leituras consecutivas do preview SQL e do
painel. Conferir sample fresco, `healthy_seconds`, transições +1/+2 e
Watchdog, além de inventário LIVE/TP/NEXT BUY. Não gerar ordem de teste.
Nenhum restart 01/02 é necessário para esta mudança.

Validação local desta entrega: 96/96 testes de Capacity/Watchdog sem skips,
22/22 SQL novamente com trigger sob service_role, lint, typecheck e build
PASS. Harness Playwright existente: 1/1 card de admissão v3 PASS, larguras
320 e 1280, OBSERVE/+1 SIM/+2 NÃO, fórmula, reserva e histerese visíveis,
sem overflow, erros Console/Network ou ação externa. Chromium headless
correspondente ao lockfile e PostgreSQL 17 ficaram no cache ignorado local.

Migration aplicada: `20260930140348_coinops_admission_hysteresis.sql`, em
30/09/2026 14:03:48 UTC. Primeiras amostras v3 reais em 14:04:41 UTC;
sem backfill artificial. SSH oficial antes da aplicação confirmou
FLEET_PARITY_PASS 2/2, SHA `63273fe3e08e499fa5f753811a8fcc76cead8727`,
Node `v24.21.0` e fingerprint `f814f67154636ecfbb0acae17b6c1b3985158e93a5450b25453be50c2f651443`.
O advisor apontou INFO RLS sem policy nas três tabelas server-only, por
design: grants clients revogados, FORCE RLS, apenas service_role BYPASSRLS.
Referência: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy.

## Rollback

Em regressão, fechar novas admissões e publicar migration corretiva revisada
que restaure as funções/policy v2 versionadas, reverta apenas policy_version
das certificações correspondentes e desabilite os triggers v3. Preservar as
tabelas/evidências; sem DROP, limpeza de histórico, alteração de conta ou
restart de motor. Reverter web pelo fluxo oficial se necessário. Nunca
reescrever `healthy_since` em produção para acelerar uma abertura.
