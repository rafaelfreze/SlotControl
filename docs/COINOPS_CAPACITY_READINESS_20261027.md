# Admissão após rollout — 27/10/2026

CoinOps / OnPlay Platform `otdfpmsegjxpqrzisfmi` / `coinops` / REAL.
Diagnóstico e correção administrativos; nenhuma alteração de estratégia ou ordem.

## Causa comprovada

A release certificada no Supabase permanecia `c9c18356...`, fingerprint
`a2aac367...`, verificada em 25/10. O rollout de 26/10 publicou `00d1dd5...`,
fingerprint `f99e55ca...`, nos dois processos. A prova de bytes carregados da
frota havia passado, mas faltou renovar o preflight persistido de admissão.
`executor_admission_readiness` recusava ambos exclusivamente por RUNTIME_PARITY.
Essa proteção é correta; a regressão foi no fechamento operacional do rollout.

Às 22:56Z de 27/10, cada shard tinha 7 motores/175 slots, zero reservas pendentes,
registry íntegro e 15 amostras reais. +1 projetava 3362,13 (56,04%) no 01 e
3329 (55,48%) no 02, abaixo de 3900/65%. CPU 3,959%/3,406%, RSS 149,25/140,46MB,
fila zero, reconciliação 22,970s/20,633s, erros/retries zero. Os timers +1 já
estavam abertos: healthy_since 15:52Z/07:12Z. Nenhum reset permanente de histerese,
reserva duplicada, perfil 50/100 ou cálculo multiplicado por motores foi encontrado.
O 03 está desabilitado desde a retirada autorizada; seus dados antigos são histórico.

## Correção e prevenção

Reutilizar `capacity-preflight.mjs`, `certificateForFleet`, `verifyFleet` e o
RPC original `certify_executor_admission`. O novo adaptador
`tools/operations/certify-executor-admission.mjs` usa a CLI Supabase oficial já
autenticada, confirma projeto/organização e consulta sempre o schema qualificado.
Não exporta dotenv/service_role. A consulta de registry é injetável no verificador
comum, que conserva todas as provas de Git, bytes carregados, Node, serviço, IP,
health, freshness e segunda leitura do registry. Shards desabilitados não entram.

Padrão `--verify`: nenhuma gravação. `--record`: somente RPC administrativo,
executado com service_role após FLEET_PARITY_PASS de todos os habilitados.
Readback exige os mesmos SHA/fingerprint/Node/policy/evidência. Resposta incerta
é observada sem repetir RPC. Perfil de slots maior já existente na mesma release
é preservado; perfil ligado a outra release exige revisão dedicada, nunca é
copiado ou apagado para liberar 25 slots.

Os scripts dos dois formatos de deploy agora emitem ADMISSION_PREFLIGHT_REQUIRED,
inclusive no caminho sem restart. AGENTS exige essa etapa para fechar rollout.
Não conceder ao coletor/cron autoridade para inventar uma certificação a partir
da versão autodeclarada na telemetria. A prova externa continua obrigatória.

```
node tools/operations/certify-executor-admission.mjs --verify --ssh-key CAMINHO_EXISTENTE
node tools/operations/certify-executor-admission.mjs --record --ssh-key CAMINHO_EXISTENTE
```

O registro foi renovado com readback ADMISSION_PREFLIGHT_PASS e CAPACITY_OK +1
em 01/02. Não houve migration, restart, novo motor, reserva de admissão, limpeza
de gates, edição de timer, relaxamento de limite ou chamada de ordem Binance.
Só as tabelas de release/atestação administrativa são gravadas pelo RPC existente.
50/100 slots continuam exigindo seus próprios perfis; não foram certificados.

## Validação

Fixtures PostgreSQL descartáveis reproduzem HEALTHY/+1 NÃO por release antiga,
renovação oficial sem alterar timer, pressão real, OBSERVE sem bloqueio indevido,
600s/reload/replay, telemetria stale/incompleta, reserva única e isolamento.
25/50/100 usam seus perfis exatos; perfis sintéticos nos testes não certificam LIVE.
O adaptador testa default read-only, falha de paridade, resposta incerta, readback
divergente, retenção de perfis e exclusão do 03. Testes existentes de router,
collector, reservas, apresentação e frota complementam o escopo.

Evidências locais: `docs/evidence/coinops-capacity-before-20261027.json` e o
readback final da auditoria. A política capacity-v3-20260930 segue 65%, reabertura
com 10 minutos contínuos até60%, reserva única35%, incremento conservador900,
crítico atual75%/projetado90%. Nenhum desses números foi alterado.
