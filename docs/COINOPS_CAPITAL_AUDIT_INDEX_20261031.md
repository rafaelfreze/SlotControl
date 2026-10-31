# Auditoria de capital: índice seletivo e recuperação — 31/10/2026

Produto CoinOps; OnPlay Platform `otdfpmsegjxpqrzisfmi`; schema `coinops`; REAL.

## Diagnóstico comprovado

Às 11:20Z o Watchdog reportava 13 motores bloqueados nos executores 01/02.
O erro compartilhado era `COINOPS_LIVE_LEDGER_READ_STALE`, root
`COINOPS_LIVE_LEDGER_READ_UNAVAILABLE`, stage `CONFIRM_CAPITAL_REFRESH`, path
`ledger/capital_refresh_events`, duas tentativas, HTTP 0. Isso não comprova
HTTP 503, erro TLS ou rejeição Binance. A conexão CLI/Management API continuava
disponível; os endpoints financeiros assinados do Executor02 estavam saudáveis.

O SELECT completo e já paginado usava o índice cronológico de escopo, mas
`event_type` era filtro residual. Em Samya/BTCUSDT o plano real descartou 38.286
eventos comuns para retornar zero eventos de refresh: 18.471,883ms, 35.043 blocos
de índice/heap no nó de scan. O deadline de observação de 5s era insuficiente
porque faltava acesso seletivo, não porque devesse ser aumentado.

## Correção mínima

- Índice não único `(run_id,event_type,observed_at,id)`, sem payload JSON incluso.
  `run_id` não substitui ownership: todos os filtros de produto/tenant/usuário/
  operador/conta/engine/moeda e `assertRowEngine` continuam obrigatórios.
- Índice completo, compatível com parâmetros `ANY($n)`; não depende da prova
  de um predicado parcial em um plano genérico.
- A leitura ordena por `event_type,observed_at,id`. Isso permite também ao plano
  genérico usar o índice seletivo e mantém paginação determinística. O conjunto
  completo de chaves CONFIRMED é calculado antes de confirmar qualquer PLANNED;
  a ordem entre os dois tipos não decide trading nem reemite confirmação.
- Permanecem duas fotografias completas, deadline 5s, intervalo 250ms, detecção
  de duplicidade/completude, falha fechada e recuperação sob lease/CAS. Não há
  retry de mutação, trading, crédito, cancelamento ou confirmação inteira.
- Nenhuma mudança de estratégia, slot, posição OPEN, preço, TP, NEXT BUY,
  capital, histórico, RLS, grants, frequência de cron ou runtime nativo.

## Aplicação e verificação

Migration `20261031112500_live_capital_audit_event_lookup.sql`, gerada pela CLI.
Histórico remoto e ausência prévia conferidos no projeto oficial. Em LIVE foi
executado somente o CREATE INDEX equivalente com CONCURRENTLY, como comando
top-level, preservando gravações. `indisvalid=true`, `indisready=true` e definição
exata foram confirmados antes de registrar a versão com `migration repair
--status applied --linked --project-ref otdfpmsegjxpqrzisfmi`. Não aplicar migrations
de outros schemas encontrados no histórico compartilhado da Platform.

O mesmo SELECT original, com o índice, levou 15,590ms e leu 3 blocos no scan,
sem descartar eventos comuns. São duas medições observadas, não um SLA de
latência. O fluxo normal retomou os motores entre 11:28:05Z e 11:30:12Z; às
11:31:02Z havia 16 runs ACTIVE, zero gates fechados/last_error, ambos os shards
HEALTHY. O Watchdog confirma a recuperação; nenhum SQL abriu gates ou resolveu
alertas financeiros. Confirmar novamente ordens/ledger e o deploy no fechamento.

## Regressões e operação futura

`tools/testing/capital-audit-index.test.mjs` aplica a migration real em PGlite
descartável: histórico com 12.000 eventos comuns, 502 eventos de capital, páginas
com timestamps iguais, escopos estrangeiros, outro engine na mesma conta,
plano genérico forçado, replay idempotente, RLS e conteúdo preservados.
`live-capital-read-server.test.ts` executa o reader/confirmador reais com fixtures:
paginação, retry de conjunto completo, erros duros, ownership e confirmação
idempotente nas duas ordens entre PLANNED/CONFIRMED. As regressões existentes de
resume comprovam TP, slots, trabalho assentado, lease e CAS, sem exchange writes.

Se a criação concorrente tiver resposta incerta, consultar definição/validade e
`pg_stat_progress_create_index` antes de qualquer nova tentativa. Não apagar
índice válido, histórico, alertas ou gates. Uma falha nova de leitura exige
diagnóstico tipado e prova financeira atual; este episódio não autoriza liberar
falha de permissão/schema, indisponibilidade persistente ou ambiguidade.

Referências: [PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html),
[Supabase Query Optimization](https://supabase.com/docs/guides/database/query-optimization).
