# Executor 03 — provisionamento de 03/10/2026

Estado vigente: correção/rollout/certificação concluídos; consultar o fechamento
ao final. As seções de provisionamento/checkpoint abaixo são histórico auditável.

## Infraestrutura confirmada no provisionamento inicial

- DigitalOcean, Droplet `605889779`, `coinops-executor-03-fra1`.
- FRA1, Ubuntu 24.04 LTS x64, Basic Regular `s-1vcpu-1gb`:
  1 vCPU / 1 GiB / 25 GB / 1 TB, US$6/mês. Sem extras/backups pagos.
- IPv4 público/egress para whitelist Binance: **167.71.37.166**.
- SSH do notebook com identidade própria; só chave pública no provedor.
  A identidade do PC não foi removida nem houve compartilhamento de private key.
- Bootstrap/assets obtidos diretamente de GitHub/main
  `07c086f1be3e24f30092abd9431b1c8f2f6a2dcd`, nunca por cópia de checkout.
- Release financeira comum: `0681027cc25985455a77893495db6d1b40d5301d`,
  Node `v24.21.0`, fingerprint
  `84f60be26e7b2a725ee004f88749c31f83ca974b96a23f1668b9fe0bc1d15e48`.
- Serviço `coinops-live-executor`, UID/GID `coinops-executor`,
  `/opt/coinops/current` → `/opt/coinops/releases/SHA`;
  estado privado separado em `/var/lib/coinops-live-executor`.
- Health HTTPS confirmou shard/SHA/IP exatos, healthy=true, NOT_ASSIGNED.
  Let's Encrypt IPv4 shortlived, renovação automática, Nginx,
  Node em 127.0.0.1:8080, firewall somente 22/80/443.
- HMAC exclusivo gerado no 03, env root0600, registry vazio0640,
  estado0700; zero credencial Binance copiada/cadastrada.

## Necessidade medida, não cota de motores

Em 03/10 21:08 UTC havia 13 motores LIVE ACTIVE, 7 no 01 e 6 no 02;
Watchdog saudável e zero incidente aberto. Para uma nova conta de 2 motores:

- 01: pressão média 2406,25 + 2×900 = 4206,25 >3900 (70,1% >65%).
- 02: 2040,75 + 2×900 = 3840,75 (64,01%), mas gate previamente bloqueado;
  recuperação requer ≤3600 (60%) por 10 min. Não cumpria a margem de reabertura.

Logo não havia admissão +2; scale-out foi explicitamente autorizado. Não reduzir
900 conservador nem a reserva única de 35%/2100, nem mover motores existentes.
O 03 herda `executor_capacity_policy()` vigente na migration, sem cota fixa.

## Integração e certificação

Migration pública `register_coinops_executor_03` somente insere ID/IP/política,
idempotente e com guardas de conflito. Alvo CoinOps, OnPlay Platform
`otdfpmsegjxpqrzisfmi`, schema `coinops`, Production, operador
`d508bb3e-5a1d-4579-bd7a-de171c118d25`, tenant
`371dbf6e-2ce4-4bfe-9e15-3a25f2905607`.

Vercel `cripto`: novo secret server-only `COINOPS_EXECUTOR_03_CONFIG_JSON`.
O secret existente `COINOPS_EXECUTOR_SHARDS_JSON` e todas as demais variáveis
foram preservados por comparação de metadados antes/depois. Sem decrypt ou
substituição de HMAC dos irmãos. Suporte aditivo testado para 03/04 e colisões.

Health individual NÃO libera onboarding. Exigir coleção server-side real,
Watchdog discovery, ≥15 amostras de weight, recursos/freshness, isolamento,
paridade de código/processo/Node/IP de todos os shards habilitados e certificação
canônica registrada. A admissão permanece fail-closed antes desses gates.
O registro persistido em `executor_admission_attestations`/release e decisões
canônicas atuais são a autoridade, não este documento estático.

Usar `fleet-parity.mjs --check-code` e `--verify` e
`capacity-preflight.mjs --record` no control plane autorizado. Se o secret
service-role não estiver disponível, não inventar nem copiar arquivo `.env`:
o conector Supabase autorizado pode descobrir/reler o registry/política e
registrar o certificado gerado pelos exports oficiais de preflight/paridade,
com as mesmas sondagens SSH e validação SQL de freshness/runtime/política.

## Continuidade / limites do provisionamento inicial

Nenhum restart/deploy no 01/02, nenhuma conta/motor movido, nenhuma alteração
financeira ou ordem usada como smoke. Samya não foi cadastrada por esta tarefa.
O 03 permanece vazio até onboarding normal pelo painel, após certificação.
Novas contas usam somente seu próprio IP/vault/HMAC.

Deploy futuro e rollback seguem `COINOPS_SHARD_DEPLOY_RUNBOOK.md`,
GitHub/main+SHA revisado e `deploy-shard.sh`; nunca copiar filesystem entre PCs
nem restaurar estado financeiro antigo. Não repetir criação/bootstrap/migration
apenas por trocar de computador; ler Droplet/registry/Git primeiro.

## Checkpoint histórico — liberação pendente antes da correção

Web publicada `807ef1f7495f896659ecf5a535f90259ebdf0e59`, deployment
`dpl_BQ2EuHGaqCL6z69ycxtyg6ejMRFK` READY no domínio canônico.
Migration remota registrada uma vez como `20261003213949`, nome
`register_coinops_executor_03` (arquivo local gerado pelo CLI às 21:30:34).
Não reaplicar por diferença do timestamp do conector: conferir nome/conteúdo.

Sondagens oficiais 21:43:41–21:43:52 UTC: FLEET_PARITY_PASS 3/3,
mesmo SHA/Node/fingerprint, código não alterado desde início dos processos.
PIDs 01=145363, 02=70221 continuam desde 30/09; 03=3381 desde 21:27:51.
Nenhum restart 01/02. Às 21:45:54 UTC: Watchdog saudável 7+6+0,
13 engines/runs ACTIVE, zero kill switch LIVE, zero incidente aberto,
23 TP SELL NEW e 13 ENTRY BUY NEW, zero conta atribuída ao 03.

**PRONTO PARA NOVA CONTA: NÃO. Não registrar certificado final nem forçar gate.**
O idle sampler usa intervalo móvel de 60.000 ms. Cron com jitter pode executar
antes desse intervalo e pular um minuto inteiro. Política v3 exige 15 máximos
por minuto UTC numa janela de 15 min. Observações reais 03 às 21:40/41/42/43
tinham 3/3/4/3 minutos amostrados; às 21:45 tinha 4, weight real 1/min,
sem erro/retry/backlog e registry vazio conferido. Não é pressão Binance real.

Reprodução offline, sem rede/credencial: usar `createCapacityTelemetry` com
fetcher fixture, relógio `minute*60000 + (minute%2 ? 50 : 150)`, 32 ticks.
Após aquecimento, todos os ticks 15..31 mantêm apenas 8 amostras na janela,
em vez das 15 necessárias. Apenas esperar não resolve a causa estrutural.

Correção indicada: alinhar o probe público ocioso ao bucket de minuto UTC,
sem criar polling adicional, reduzir samples/headroom ou fabricar history.
Como esse arquivo integra o fingerprint comum, exige nova release canônica
e rollout sequencial dos três shards. Esse foi o bloqueio da autorização anterior.
Em 03/10 o proprietário autorizou explicitamente a correção e o rollout
01 → 02 → 03, mantendo todas as proteções e a certificação fail-closed.
Não publicar apenas no 03 e declarar paridade falsa. Depois do rollout,
aguardar 15 amostras reais e 10 min saudáveis, registrar preflight oficial e
confirmar +2 SIM pelo painel, ainda vazio. Nenhuma conta Samya foi cadastrada.

## Fechamento — coleta corrigida e admissão certificada

Em 03/10/2026, rollout sequencial autorizado 01 → 02 → 03, somente
`coinops-live-executor`. Cada etapa confirmou estado LIVE, reconciliação,
TP/NEXT BUY, incidentes e Watchdog antes/depois; nenhum restart simultâneo.
Assets diretamente de GitHub/main `89e303e4a6ef2ef80fdece0aab450b9bf464f25e`,
runtime comum `0f5c1071f30f3859379e3b7ce01b4a9fac9be724` nos três servidores,
Node `v24.21.0`, 23 arquivos, checksum
`dfd5888668f364dd439589120346227bf475c8d4d6f2f429a26bcbc2ef879879`.

| Shard | IPv4 | Início do processo UTC | PID | Resultado |
| --- | --- | --- | --- | --- |
| executor-01 | 46.101.104.48 | 22:07:17.800670 | 175900 | HEALTHY, 7 motores |
| executor-02 | 164.90.223.159 | 22:09:16.541852 | 97433 | HEALTHY, 6 motores |
| executor-03 | 167.71.37.166 | 22:11:25.250239 | 4108 | HEALTHY, vazio |

Sondagens oficiais 22:38:33–22:38:44 UTC: **FLEET_PARITY_PASS 3/3**, identidade
IP/processo/UID/Node e fingerprint exatos, código não alterado após início do
processo. Registry oficial relido antes/depois, sem mudança. Certificado gerado
pelos exports de `fleet-parity.mjs`/`capacity-preflight.mjs`, registrado uma vez
pelo conector autorizado no RPC canônico `certify_executor_admission`, em
escopo CoinOps/ref `otdfpmsegjxpqrzisfmi`/schema `coinops`/Production e role
`service_role`: **ADMISSION_PREFLIGHT_PASS** às 22:39:18.455927 UTC.
Releitura confirmou três attestations e release comum exatas, readiness=true
sem falhas nos três shards. Não copiar service-role localmente para certificar.

03 atingiu 15 amostras reais às 22:25:42.330 UTC, mantendo 15–16 a cada coleta.
Histerese começou nessa amostra e reabriu automaticamente às 22:36:42.275,
após 659,945s saudáveis. GET/reload não avançou o estado; não houve bypass,
backfill, alteração do mínimo, reserva ou custo incremental. Às 22:39:34,
`preview_executor_admission('executor-03','REAL',2)` = **CAPACITY_OK**:
1,06 sustentado + 0 reservado + 2×900 = 1801,06 /6000 (30,02%), abaixo de
3900 (65%), reserva única 2100 (35%) preservada. UI autenticada confirmou
**+1 SIM / +2 SIM** com IP 167.71.37.166, CPU ~0,1%, RAM ~118 MiB,
fila normal/reconciliação 0s corretamente reconhecida como shard vazio.
01/02 +1 SIM; +2 NÃO pelas próprias projeções medidas, sem forçar admissão.
Capacidade é dinâmica; não é certificação de uma cota fixa de motores.

Gates: CONFIG_PARITY, RUNTIME_PARITY, CAPACITY_POLICY_PARITY, TELEMETRY_ACTIVE,
BINANCE_WEIGHT_TRACKING, WATCHDOG_DISCOVERY, ADMISSION_GATE_ACTIVE, HEALTHY,
heartbeat/scheduler/reconciliação, FLEET_PARITY e preflight: **PASS**.
Leitura 22:39:11: **13/13** engines/runs ACTIVE, 25 slots físicos cada,
23 posições com TP residente, 13 NEXT BUY, zero kill switch LIVE ou incidente.
Hashes de estratégia/vínculos/ordens residentes/posições idênticos ao baseline
pré-rollout. Logs warning/error pós-restart e restarts automáticos: zero.
Watchdog HEALTHY 7+6+0. 03: zero contas, zero motores, sem credencial Binance.

106 testes executor +18 config/health web +45 capacidade (22 SQL em banco
local descartável), lint dirigido, typecheck e build isolado: PASS. Testnet
permanece desativada; mocks históricos corrigidos só no harness offline.
Detalhes da causa/regressões: `COINOPS_IDLE_CAPACITY_COLLECTION.md`.

Publicação web pré-rollout foi necessária à compatibilidade de versões antes
de reiniciar LIVE: Git `89e303e`, deployment `dpl_Dbc8MeQcWFzuRPJfNhTNytXmeY6b`
READY. Janela exata 0681027→0f5c107, 22:05:02–22:45:02 UTC; o resolver passa
a aceitar só 0f5c107 no fim, sem redeploy/renovação. Fechamento Git inclui só
testes/documentação adicionais, fingerprint de runtime inalterado: **não exige
novo deploy/restart de VPS**. Todas as variáveis sensíveis preexistentes intactas.

**PRONTO PARA NOVA CONTA: SIM, para onboarding normal pelo painel.** Não houve
cadastro de conta, atribuição/reserva ou operação Binance por esta tarefa.
Nenhuma migration nova nesta correção; não repetir a migration do 03, criação,
bootstrap, configuração do HMAC, deploys ou certificação após trocar de PC.
O gate será revalidado no último instante pelo fluxo oficial de onboarding.
