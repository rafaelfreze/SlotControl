# CoinOps: edição de estratégia em massa (REAL)

Escopo inicial: `post_ath_spacing_rate` dos perfis oficiais, nunca uma configuração paralela. O seletor e a prévia são leituras; só a confirmação do proprietário do operador chama `coinops.enqueue_strategy_bulk_post_ath`. Uma requisição duplicada com o mesmo `idempotency_key` retorna o mesmo lote ou falha se o payload divergir.

## Ordem de publicação e rollback técnico

1. Confirmar GitHub/main, estado dos shards, ausência de alertas e reconciliação recente; preservar outros trabalhos.
2. Aplicar a migration versionada **antes** do runtime: a coluna `strategy_config_pending` nasce `false` e o gatilho só restringe BUY de um engine com atualização pendente. SELL/TP e reconciliation não são bloqueados.
3. Publicar o runtime e a UI do mesmo SHA. Confirmar leitura autenticada, preview sem write, status do Watchdog, e motores íntegros. Não alterar perfil/ordem REAL como smoke.
4. Se runtime novo falhar, reverter o deploy de código somente se não houver nenhum item `PENDING`, `APPLYING` ou `BLOCKED_SAFE`. Com item pendente, preservar migration/gate e recuperar primeiro o engine por seu checkpoint; não remover o gatilho nem liberar BUY manualmente.

## Estados e invariantes

`PENDING` fecha a admissão de BUY na tabela `trading_engines`, inclusive para uma ordem `PREPARED` ainda sem guarda. O reconciliador oficial adquire lease do run, reconcilia ordens e fills, protege toda posição OPEN com TP e só então entra em `APPLYING`. A versão do perfil é atualizada por CAS, e o run guarda a mesma versão/snapshot. Em regime POST_ATH, somente BUY de entrada ainda não preenchida pode ser cancelada sob `onlyUnfilled`; timeout exige leitura do mesmo `clientOrderId` na Binance. O ladder oficial reordena/reprecifica apenas slots futuros, e `finish_strategy_bulk_engine_update` só abre o gate depois de versão/lease e ausência de BUY antiga ativa. Em regime NORMAL o parâmetro pós-ATH muda, mas a BUY NORMAL compatível permanece.

OPEN, fills, quantidade, custo, ganho e TP existente não são reescritos pela atualização. O snapshot da ordem preserva as taxas vigentes na decisão original. Uma BUY preenchida ou parcialmente preenchida vence a corrida: reconciliar e proteger a posição, sem substituição especulativa. Sem verdade verificável, `BLOCKED_SAFE` e bloqueio de novas entradas apenas no engine; TP continua gerenciado. Não usar cancel-all, MARKET cega ou edição manual do ledger.

`APPLIED` é confirmação por engine, não inferência a partir do botão. O Watchdog trata pendência recente como `RECOVERING`; pendência stale é recuperável pela mesma execução reconciliada, e `BLOCKED_SAFE` requer investigação. O monitor de seis horas não classifica a falta transitória de BUY durante uma edição como engine órfão. Falha local não altera gate de outras contas, motores ou shards.

Se navegador, aplicativo ou PC fechar durante a admissão de um lote já confirmado, o plano e o cursor permanecem duráveis. Ao reabrir, a interface mostra `Aplicação confirmada interrompida`; nenhuma escrita recomeça só por navegar. O ADMIN deve usar `Retomar aplicação confirmada`, que continua pelo mesmo `batch_id` e cursor idempotente. O histórico mantém acesso ao resultado e à prévia de rollback após recarregar a página.

## Diagnóstico e recuperação

- `COINOPS_OPERATOR_REGISTRY_UNAVAILABLE` com HTTP 403/SQLSTATE `42501` em `exchange_accounts`: conferir privilégios por coluna da role `authenticated`. Campos novos usados pelo registry precisam de `GRANT SELECT (campo)` versionado; não conceder `SELECT` irrestrito na tabela. A policy `operator_owned` e RLS devem permanecer ativas.
- `COINOPS_BULK_PREVIEW_CONFLICT`: seleção, valor, run, perfil ou versão mudou entre preview e confirmação. Repetir preview; não reutilizar o hash anterior.
- `COINOPS_BULK_PROFILE_CONFLICT` / `COINOPS_BULK_VERSION_MISMATCH`: conferir `profile_id`, `run_id`, versão, valores e edição individual pendente. Nunca forçar versão.
- `COINOPS_BULK_PREPARED_BUY_AMBIGUOUS`, `COINOPS_LIVE_FILLED_DURING_SNAPSHOT`, `COINOPS_LIVE_BUY_CANCEL_UNRECONCILED`: obter estado exato da ordem por `clientOrderId`, fills e ledger antes de qualquer nova ação.
- `COINOPS_BULK_TRANSIENT_EXECUTOR_READ`: retry do mesmo checkpoint enquanto recente; após janela segura, bloquear apenas este engine e investigar.
- `WATCHDOG_CONFIG_UPDATE_STALE`: conferir lease, status do item, perfil/run/ordens e saúde do executor; retomar exclusivamente pelo reconciliador oficial.
- `ROLLBACK_DIVERGED`: lote anterior não é mais versão atual. Rollback cego é proibido; nova prévia explícita e decisão do operador são necessárias.

O rollback é outra atualização versionada sobre o estado **atual**, não ressuscita ordens antigas. Só é elegível se o perfil ainda estiver exatamente na versão e valor produzidos pelo lote original.

## Evidência de conclusão

Registrar `batch_id`, SHA/deploy, `created_by`, versão anterior/nova e status por engine. Exigir todos os itens `APPLIED`, nenhuma pendência/gate, reconciliations recentes, OPEN/TP íntegros, no máximo uma NEXT BUY por engine e ausência de alertas novos. Prévia e testes de fixture não certificam Binance Production; não gerar ordem LIVE para provar o fluxo.
