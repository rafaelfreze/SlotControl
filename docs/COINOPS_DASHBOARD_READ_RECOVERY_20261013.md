# Recuperação de leitura do painel

## Evidência e causa

Em 13/10/2026, `GET /automacao` falhou com `COINOPS_LIVE_LEDGER_READ_FAILED` às 12:45:39.743Z e 13:01:14.790/19.964/23.925Z. As consultas correspondentes em Supabase terminaram com SQLSTATE `57014` às 12:45:39.708Z e 13:01:14.725/19.893/23.905Z: `robot_v1_live_events`, últimas 20 atividades ordenadas por observed_at, filtrando a conta/run e ANY dos motores legados. A exceção descartava todo o painel por uma falha no feed histórico, não nas ordens.

O índice `robot_v1_live_events_scope_recent_idx(operator_id, exchange_account_id, trading_engine_id, run_id, observed_at DESC)` já existe. O leitor agora vincula os quatro campos de igualdade, inclusive operator e engine exato do run. EXPLAIN do SELECT escopado confirmou uso desse índice; sem migration, criação de índice redundante ou aumento de timeout.

Além disso, no Next 14 instalado, `reset()` sozinho apenas limpa o estado do error boundary: não exige novo RSC GET. O marcador antigo de retry nunca era limpo após sucesso, esgotando a recuperação pelo resto da sessão. Isso explica a necessidade de fechar/reabrir o aplicativo.

## Contrato

* `legacy-live-dashboard-read.ts` valida run/conta/engine e 25 slots/contas físicos, pagina ordens e aportes. Reutiliza o observador GET-only canônico: até dois conjuntos completos, 5s por tentativa, 250ms entre eles, descartando conjunto parcial. Não executa reconciliador, estratégia ou writes.
* Histórico é leitura independente, única, de até 5s e 20 eventos. Sua falha produz `historyUnavailableAssets`/aviso explícito, sem repetir o core, perder posições já verificadas ou afirmar que não há eventos.
* Falha do core invalida somente o motor/ativo correspondente, sem herdar dados antigos ou impedir leitura dos outros motores. Permissão/schema/identidade não viram retry transitório.
* Falhas persistem em logs sanitizados por estágio/http_status/provider_code/attempts; nenhum payload financeiro, credencial ou mensagem privada do provider é registrado.
* Error boundary solicita `router.refresh()` + `reset()` em uma transição. Somente digest público derivado de timeout transitório tipado autoriza até duas tentativas (5s/15s). Permission/Auth/schema/desconhecido continuam explícitos. Offline/oculto não consomem tentativas. Novo orçamento apenas após renderização bem-sucedida do painel; foco e tempo não o renovam.

## Aviso de saldo já comunicado

O ADMIN pode reconhecer e ocultar **neste aparelho** apenas WARNING conhecida de quote Spot/BNB, com evidência atual íntegra e sem outra falha. A identificação é engine + código + horário do aviso; reincidência ou código novo volta a aparecer. O usuário pode reexibir avisos reconhecidos.

Ocultar é preferência visual local, não `resolved_at`, pause/kill, liberação de BUY, supressão de push ou correção financeira. O ledger permanece íntegro. O motor continua identificado como `AGUARDANDO SALDO`, não como OPERANDO/HEALTHY; TPs e reconciliação permanecem normais. Erro crítico, outcome ambíguo, TP ausente, dado stale, cap excedido ou ledger incompleto nunca pode ser ocultado por esse comando. Nenhum saldo/valor é salvo no localStorage.

## Validação

Regressões: 503 com descarte do conjunto parcial; feed 57014 mantendo core; >1000 ordens; RLS/42501/schema/42703 sem retry; isolamento de siblings; 25 slots únicos; budget por episódio; reset com RSC refresh; mobile/desktop; acknowledgment por fingerprint e nova ocorrência visível; estado de espera distinto de saúde confirmada.

O RPC de leitura `dashboard_live_engine_reads` e o fallback nativo passam a incluir `trades_reconciled` na projeção de ordens. A migration `20261013135419_add_dashboard_order_reconciliation_evidence.sql` acrescenta somente esse campo; preserva a definição restante, SECURITY INVOKER, filtros, owner, grants e RLS. Sem prova de fill reconciliado, o aviso não pode ser reconhecido como espera simples de saldo.

Trading, cron, Watchdog, capacidade, capital, OPEN, TP e NEXT BUY não mudam. Nenhum restart de executor ou escrita financeira; somente a extensão aditiva do contrato de leitura acima.
