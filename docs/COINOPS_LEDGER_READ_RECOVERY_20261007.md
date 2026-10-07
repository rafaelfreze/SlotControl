# CoinOps — leitura do ledger e recuperação segura

## Incidente e evidência

Em 07/10/2026, 15:25:09 UTC (11:25:09 America/Campo_Grande),
Samya/SOLUSDT, engine `b4d30a96-71a3-4e44-a633-13bc419be7e1`,
run `89bc316b-8b6d-4e2a-a8c0-e14ecd3889c8`, Executor 03,
incidente `761efdb5-0a00-4458-9eda-9f77ec5f0c3c`, registrou
`COINOPS_LIVE_LEDGER_INCOMPLETE` em `RECONCILE_ORDERS`.

O código anterior emitia esse mesmo erro para falha de qualquer consulta ou
quantidade incorreta de slots/contas. Descartava HTTP/provider/resource. O erro
original de transporte não está disponível: não afirmar 503, timeout ou Earn
como causa comprovada deste episódio.

Às 15:40 UTC, leitura autenticada, read-only, confirmou 25 slots físicos e
25 contas; dois OPEN protegidos por TPs Binance `17928106611` (.081 SOL) e
`17944870090` (.084 SOL), NEXT BUY `17944871406` (.087 SOL), todos NEW e
com clientOrderId/ownership exatos do engine. SOL locked .165, sem fill
pendente. Última criação financeira ocorreu às 13:13 UTC, não no instante
do alerta. A reconciliação normal voltou a OK, mas parava em KILL_SWITCH.
Watchdog detectou e manteve BLOCKED, sem recovery em andamento.

## Contrato de leitura

- `runRows` usa 2 tentativas completas, deadline 5s/tentativa e intervalo 250ms.
- Apenas consultas GET são retryable. Nunca repetir despacho/mutação ou etapa
  financeira inteira por causa de erro de leitura.
- Descartar resultado parcial. Aguardar todas as consultas limitadas; erro
  estrutural/permissão vence falha transitória concorrente.
- Slots/contas devem conter exatamente números físicos únicos 1..25. Validar
  ownership de todas as linhas. Ordens são paginadas (500), ordenadas por
  created_at + id; truncamento PostgREST não pode esconder ordem histórica.
- Retry somente de conexão/pool/cancelamento de leitura conhecido, deadline
  próprio sem erro real do provider, fetch GET indisponível e gateway 502/503/504.
  HTTP não substitui um provider code de permissão/schema. Ver mapeamento
  oficial: https://docs.postgrest.org/en/v13/references/errors.html.
- Exaustão: `COINOPS_LIVE_TRANSIENT_LEDGER_READ`, checkpoint WARNING durável
  no reconciliador normal, sem last_error/freshness falsos. Compartilha a chave
  histórica TRANSIENT_EXECUTOR_READ para não criar dois relógios de outage.
- Após >5min sem observação completa: `COINOPS_LIVE_LEDGER_READ_STALE` bloqueia
  somente novas BUY do engine afetado; nenhuma ordem residente é cancelada.
- Permissão/schema: `COINOPS_LIVE_LEDGER_READ_FAILED`, fail-closed sem recovery
  automático. Ledger realmente incompleto mantém `LEDGER_INCOMPLETE`.
- Evidência persistida: recurso, tentativas, HTTP e provider code validado.
  Nunca guardar message/details/hint/stack, URL assinada, JWT ou credenciais.

## Recuperação

Não limpar kill switch/alerta por SQL. Não reconstruir slots ou ciclo.
Não clicar Ativar novamente. O fluxo normal reconcilia primeiro e usa
`resumeLiveRun(..., VERIFIED_READ_RECOVERY)` somente após OK/ACTIVE:

1. Lease do run e resolução fresca de escopo/engine/shard.
2. Mesmo e único CRITICAL, alert key do run, code/timestamps inalterados.
3. Para código legado LEDGER_INCOMPLETE, exigir origem exata LOAD_LEDGER ou
   RECONCILE_ORDERS + root_code idêntico. Para READ_STALE, exigir root typed
   LEDGER_READ_UNAVAILABLE e recurso ledger allowlisted.
4. Executor saudável, flags válidos, nenhum bloqueio de conta/global.
5. Ledger completo, posição protegida Binance × ledger, nenhum fill pendente,
   no máximo uma BUY residente, mensal/caps/exposição válidos.
6. Revalidar incidente após leituras externas, renovar lease e CAS do alerta.
   Divergência/falha impede retomada ou rebloqueia exclusivamente esse engine.
7. Persistir LIVE_RESUMED e ação VERIFIED_READ_RECOVERY. Watchdog observa
   independentemente o estado final antes de encerrar RECOVERED.

Elegibilidade não certifica completude nem autoriza POST. Uma verdadeira
ausência de slot, TP, ownership ou dado financeiro nunca passa essas provas.
O Watchdog permanece fallback; o reconciliador normal resolve leitura transitória.

## Validação e release

Fixtures: gateway/pool/timeout, exaustão, permissão junto de outage, ledger
24/25 ou números duplicados, null/malformed, 1201 ordens, mesma conta em
engines/shards distintos, TP ausente, executor unhealthy, incidente/CAS alterado,
retry sem falsa freshness, recuperação sem POST/cancel. Relatórios v20 incluem
o contrato e evidência persistida; ausência de prova não vira PASS.

Somente web/control plane; não modifica grafo/runtime de executor, não exige
restart VPS nem mudança de secrets/credenciais/migration. Após Git/main e READY,
aguardar cron normal e comprovar engine/ledger/Binance + Watchdog. Nunca provocar
trade LIVE como teste. Rollback via versão web anterior; preservar histórico.
