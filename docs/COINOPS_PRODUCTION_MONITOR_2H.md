# CoinOps — monitor Production a cada 2 horas

Política operacional atualizada em 27/09/2026. Este runbook orienta a rotina
Codex existente; não cria outro agendamento nem substitui o watchdog.

## Responsabilidades

- **Camada 1 — server-side, aproximadamente a cada minuto:** watchdog,
  telemetria e reconciliador LIVE, conforme `COINOPS_SERVER_WATCHDOG.md`.
  Resolve somente classes conhecidas e comprovadamente seguras. Não depende
  de navegador, PC, Codex ou sessão do ADMIN.
- **Camada 2 — Codex, a cada duas horas, sem prazo final:** supervisão de
  Production REAL, validação de incidentes e evolução dirigida do watchdog.
  A execução saudável deve ser rápida, barata e somente leitura.
- Testnet, chaos tests, carga sintética e auditoria de escala **não fazem parte
  desta rotina**. Fixtures/Testnet podem validar uma correção específica
  quando necessárias; nunca provocar falhas ou trades para testar Production.

## Fontes, descoberta e checkpoint

Usar o registry oficial e o vínculo validado conta → `executor_shard_id`.
Descobrir todos os shards, contas e motores REAL atuais; nunca manter lista
fixa de nomes, IPs, quantidades ou mercados.

Priorizar `watchdog_checks`, `watchdog_incidents`, telemetria de capacidade,
engines/runs, slots, ordens/alertas do ledger e entregas push já persistidas.
Campos/tabelas concretos devem corresponder ao schema/runtime vigente.
Dados ausentes ou stale são lacuna de evidência, não zero nem HEALTHY.

Recuperar o último checkpoint concluído da rotina e os incidentes criados **ou
atualizados** desde então. Usar pequena sobreposição de janela e deduplicar
por incidente/atualização para não perder recovery entre execuções. Persistir
UTC de início/fim, fontes consultadas, IDs e estado final no registro da rotina.
Não avançar o watermark de sucesso se a leitura ficou incompleta; indicar a
lacuna e preservá-la para a próxima execução.

## Fast path normal — somente leitura

1. Consultar estado/frescor do watchdog e incidentes novos/atualizados.
2. Conferir todos os executores: heartbeat, ownership, scheduler, backlog,
   CPU/RAM, peso Binance atual/média/pico e Capacity Manager.
3. Conferir todas as contas/motores REAL: ACTIVE, BLOCKED, STALE ou RECOVERING,
   reconciliation age, alertas, kill switches e vínculo conta/engine/shard.
4. Conferir ciclo/slots e consistência básica de TP/NEXT BUY pelos dados
   internos. A estratégia efetiva determina o esperado; não assumir uma BUY
   em estados nos quais ela não é devida.
5. Consultar entregas/deduplicação push pertinentes a incidentes, sem enviar
   push de teste a cada rodada.

TP residente no ledger sozinho não prova proteção na Binance. Usar também
reconciliação fresca e seu resultado; consultar Binance pontualmente apenas
quando uma inconsistência exigir, com o menor escopo e custo possível.

Sem incidente/lacuna relevante, registrar o resumo abaixo e encerrar. Não
executar build, suíte completa, deploy, auditoria ampla, consulta pesada
Binance ou qualquer mutação. Não repetir notificações por estado saudável ou
aviso conhecido e inalterado; respeitar a preferência da automação.

```text
COINOPS_2H_OK
executores: X/X
motores: X/X
incidentes novos: 0
watchdog: HEALTHY
capacity: estado real por shard
```

Preencher somente com evidência atual. Se o watchdog reportar ATTENTION,
DEGRADED ou outro estado, não substituí-lo por HEALTHY. Aviso de capacidade
conhecido não significa falha de trading, mas deve permanecer explícito.

## Incidente recuperado pelo watchdog

Preservar detecção, `incident_id`, causa, decisões, ações automáticas,
reconciliação posterior e validação final. Verificar que os demais motores
e shards permaneceram intactos. Correlacionar alertas, eventos e entregas
push; não inferir recovery pelo desaparecimento do alerta nem entrega física
de push pela existência da outbox.

Registrar `WATCHDOG_RECOVERY_CONFIRMED` quando a evidência demonstrar o
recovery. Não modificar código, reabrir auditoria ou repetir testes sem
necessidade. Não renotificar o mesmo episódio a cada duas horas sem mudança.

## Incidente não resolvido — engenharia no menor escopo

Primeiro capturar o episódio real e a atuação server-side. Não executar
recuperação manual imediata que apague a evidência de falha do watchdog.
Conferir sua cadência/frescor antes de chamar atraso de bug. Diante de risco
material, preservar estado e alertar; não prolongar observação apenas pela prova.

1. Recuperar Git/branch/HEAD/upstream/main, working tree, deploy, executor,
   cron e escopo de dados antes de editar. Preservar trabalho alheio.
2. Identificar shard, conta, engine, mercado, run/ciclo e código do erro.
3. Confrontar ledger, executor e Binance quando necessário para determinar
   a verdade, inclusive ordens de resultado incerto.
4. Demonstrar causa raiz; distinguir falha recuperável de condição esperada,
   credencial inválida, dependência externa ou decisão humana.
5. Corrigir o menor escopo. Só ampliar política/runbook automático quando
   detecção, ação determinística, idempotência e isolamento forem provados.
6. Adicionar regression test; validar em fixtures/Testnet quando aplicável,
   nunca reproduzindo o incidente artificialmente em REAL.
7. Executar testes direcionados e validação proporcional; revisar diff,
   commit/push/deploy pelo fluxo oficial e confirmar a versão publicada.
8. Deixar recovery financeiro ocorrer somente no fluxo server-side autorizado,
   com lease, snapshot, idempotência e reconciliação. Confirmar invariantes e
   integridade dos outros motores após a atuação.

Não alterar Strategy Engine, gain, spacing, TP ou NEXT BUY para contornar
alerta. Mudança nesses componentes exige causa raiz comprovada e testes
específicos; não faz parte do fast path de monitoramento.

## Ambiguidade, isolamento e capacidade

`shard A / account A / engine A` nunca autoriza bloquear, reiniciar, migrar
ou modificar `shard B / account B / engine B`. Kill switch local não vira
global. Não parar motores saudáveis para corrigir outro.

Resultado incerto permanece `BLOCKED_SAFE` **somente no engine afetado**,
pelo fluxo guardado existente. Investigar Binance + ledger + histórico;
não limpar alerta/kill switch por SQL nem adivinhar BUY, SELL, TP, reset ou
NEXT BUY. Não cancelar/substituir ordem saudável para testar. Nenhum write
financeiro pode ocorrer sem prova de escopo, estado e idempotência.

WARNING/CAPACITY_LIMIT orienta SCALE_OUT; CPU/RAM sustentados e medidos
podem orientar SCALE_UP. Capacity Manager continua controlando novas
admissões. Não alterar trading, thresholds ou criar recurso cobrável nesta rotina.

## Aprendizado permanente de nova classe de falha

Versionar política/runbook, documentação pertinente e teste junto da correção:

- error code e causa raiz;
- condição inequívoca de detecção;
- precondições e condição segura de recovery;
- ação server-side permitida e ações proibidas;
- lease/lock, idempotência e escopo do blast radius;
- validação pós-recovery e escalonamento para BLOCKED_SAFE;
- regression test, SHA/deploy e evidência real quando disponível.

Sem essas provas, não adicionar a classe ao auto-recovery. Código/runtime e
runbook versionados são a memória operacional; o histórico do chat não é.
Este procedimento não autoriza o watchdog a alterar seu próprio código.

## Entrega quando houver mudança material/incidente

```text
INCIDENT_ID:
HORÁRIO:
SHARD:
CONTA:
MOTOR:
ERRO:
CAUSA RAIZ:
WATCHDOG DETECTOU: SIM/NÃO/NÃO COMPROVADO
WATCHDOG RECUPEROU: SIM/NÃO/NÃO COMPROVADO
AÇÃO DO CODEX:
CÓDIGO ALTERADO:
TESTE ADICIONADO:
SHA:
DEPLOY:
ESTADO FINAL:
BLAST RADIUS:
RECOVERY FUTURO AUTOMÁTICO: SIM/NÃO + motivo
```

Usar “não aplicável” para código/teste/deploy quando não houve mudança.
Classificar conclusões como COMPROVADO, INFERIDO ou NÃO TESTADO. Nunca declarar
recuperação, isolamento, health, deploy ou push por inferência.
