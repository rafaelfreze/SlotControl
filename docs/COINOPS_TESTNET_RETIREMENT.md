# Descontinuação operacional da Testnet — 30/09/2026

## Runtime do executor

A política versionada `testnet-policy.ts` também é importada pelo servidor
do executor. Após assinatura e isolamento de shard, qualquer envelope
TESTNET ou `/v1/testnet/transport` recebe HTTP 410
`COINOPS_TESTNET_DISABLED`, antes de vault, registry ou Binance. Flags
antigas não reativam Testnet. `/v1/capacity` coleta somente REAL e informa
Testnet DISABLED/RETIRED, sem evidência de peso, nunca peso zero.
Não enumera credenciais históricas nem inicia a sonda pública Testnet.

Testes offline históricos do transporte continuam disponíveis. Suite do
executor: 102 PASS, incluindo rejeição de GET/order/test/POST/DELETE e
isolamento. Isso não prova rollout: publicar sequencialmente nos shards
pelo manifest/runbook e exigir FLEET_PARITY_PASS antes de fechar.

Decisão do proprietário: ocultar e desativar Testnet. Somente REAL permanece
no menu e no cadastro de contas. `testnet-policy.ts` é a política versionada;
`COINOPS_TESTNET_ENABLED=true` remanescente não reabre a operação.

## Escopo e auditoria

- Links Testnet antigos e overview redirecionam para REAL/ALL antes da leitura
  operacional. IDs da seleção antiga não são reaproveitados para operar REAL.
- Actions, credenciais/onboarding, execução, reconciliação, diagnóstico e probe
  de push Testnet são bloqueados server-side.
- Removido o cron Testnet por minuto da configuração Vercel. Rotas antigas de
  cron mantêm autenticação e retornam DISABLED sem consultar ledger/exchange.
- Capacity Manager deixa de persistir/coletar o ledger Testnet; REAL conserva
  sua política e seu agendamento.
- Nenhuma conta, ciclo, fill, slot, ordem ou credencial é apagado. Relatórios
  históricos read-only e testes offline continuam disponíveis. Estados ACTIVE
  antigos do ledger são a última fotografia histórica, não execução habilitada.
- Não há cancelamento de ordens nem mudança de status/kill switch REAL ou de
  contas compartilhadas. A descontinuação é global no control plane, não um
  kill switch de conta.

## Limite de infraestrutura

A primeira entrega retirou Testnet do web/control plane, sem restart. A
entrega complementar de runtime foi publicada em 30/09 às 21:50Z no 01 e
21:52Z no 02, pelos scripts canônicos, preflight como usuário systemd e
rollback compatível. Ambos executam `0681027cc25985455a77893495db6d1b40d5301d`,
Node `v24.21.0`, fingerprint de 23 arquivos
`84f60be26e7b2a725ee004f88749c31f83ca974b96a23f1668b9fe0bc1d15e48`.
FLEET_PARITY_PASS 2/2 às 21:53:50Z, registry relido sem mudança; nova prova
às 22:04Z e ADMISSION_PREFLIGHT_PASS persistido. Não foram copiados secrets,
vaults ou estado; a janela pública de versões termina às 22:15:24Z.

O gate de admissão e a saúde do processo são sinais distintos. Durante a
janela de amostragem/recuperação, cadastro pode ficar NÃO sem o executor
estar OFFLINE. A API apresenta saúde pela telemetria, mantendo decisões
de +1/+2 exclusivamente do RPC persistido. Não encurtar a histerese nem
fabricar amostras para ocultar um indicador. LIVE, ordens e regras não mudam.

## Validação segura

Teste a política com variável antiga habilitada, os guards de factories/actions,
remoção exclusiva do cron Testnet, menu/cadastro sem opção Testnet e redirect
do link antigo. Smoke de diagnóstico: HTTP 410/COINOPS_TESTNET_DISABLED.
Conferir os motores REAL e timestamps Testnet via leitura; não ativar ou
reconciliar motores para testar a descontinuação.
