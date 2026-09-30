# Descontinuação operacional da Testnet — 30/09/2026

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

Esta entrega é web/control plane, sem reiniciar os executores LIVE. O payload
de capacidade do runtime já publicado ainda pode incluir a sonda pública
Testnet isolada. Ela não avança ciclos nem envia ordens, e sua evidência deixa
de ser processada/persistida pelo coletor web. Remover essa sonda do runtime
exige uma entrega própria com rollout sequencial e FLEET_PARITY_PASS.

## Validação segura

Teste a política com variável antiga habilitada, os guards de factories/actions,
remoção exclusiva do cron Testnet, menu/cadastro sem opção Testnet e redirect
do link antigo. Smoke de diagnóstico: HTTP 410/COINOPS_TESTNET_DISABLED.
Conferir os motores REAL e timestamps Testnet via leitura; não ativar ou
reconciliar motores para testar a descontinuação.
