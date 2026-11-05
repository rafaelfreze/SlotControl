# TP confirmado: encerrar o hold antes do planejamento

CoinOps REAL / OnPlayPlatform `otdfpmsegjxpqrzisfmi` / schema `coinops`.
Incidente Thyely/SOLBRL em05/11/2026, Executor01, engine
`fa551904-15da-4e17-8259-b0a76e206fac`, run
`53d2c2ef-a37f-48ee-8aff-4b3843f73e27`.

## Causa comprovada

Às14:56:51UTC o orçamento do TP #9 ficou desconhecido e gerou o alerta
`COINOPS_ACCOUNT_ORDER_BUDGET_UNKNOWN` de SELL. O fluxo normal confirmou o TP
às14:57:38: ordem438095809, decisão COMPLETED, reserva com ACK. Contudo, a
baixa desse alerta ficava depois de `armNextEntry`. O RPC de prioridade recusa
qualquer CRITICAL não resolvido do próprio engine; portanto a fila não podia
alcançar a etapa que encerraria o alerta já superado. O wrapper registrou
`COINOPS_LIVE_ENTRY_PRIORITY_COMMIT_UNPROVEN / ARM_ENTRY` às14:57:47 e fechou
somente os gates desse engine. O Watchdog detectou às14:58:46.

Leitura independente confirmou7OPEN/7TP/zeroBUY,25slots e zero dispatch pendente.
O código SQL vigente e o teste descartável comprovam o guard e o rollback
atômico. Não inferir503 ou outra causa do primeiro orçamento desconhecido:
esse diagnóstico upstream não foi persistido.

## Correção mínima

Mover a chamada existente de `resolveAccountBudgetAlert` para depois da
reconciliação/proteção integral e antes de configuração, ATH/reset e entrada.
O modo interno `PROTECTED_DISPATCH_RECONCILED` conserva o contrato existente:
ordem própria exata, decisão COMPLETED, reserva com ACK no mesmo shard,
identidade/run/slot/operação íntegros, renovação de lease e CAS do mesmo alerta.
Não há nova implementação de estratégia, cron ou consulta extra no caminho
saudável: a mesma chamada foi deslocada, não duplicada.

- `ABSENT`: seguir sem UPDATE vazio.
- `RESOLVED`: apenas o hold comprovado terminou. Não certifica a capacidade
  Binance atual nem libera outro incidente/gate.
- `DEFERRED`: retornar RETRY com
  `COINOPS_LIVE_ACCOUNT_BUDGET_RECOVERY_PENDING`, sem planejar BUY, renovar
  freshness fictícia, ocultar alerta ou repetir operação financeira.
- Erro duro/metadata ambígua mantém o fail-closed local e diagnóstico existente.

Cada próximo dispatch continua exigindo orçamento Binance fresco, capital,
filtros, BNB, ownership e idempotência próprios. OPEN/TP, histórico, metas,
gain, spacing, ranks físicos e saldos não mudam.

## Recuperação e limites

No caso já bloqueado, aguardar a versão corrigida reconciliar e encerrar o hold
de TP com prova exata. Depois, se restar somente o incidente identificado,
confrontar Binance/ledger/engine e retomar pelo controle oficial sob lease,
decisões/dispatches assentados e CAS. Nunca limpar gates/alertas por SQL nem
reenviar/cancelar ordens manualmente para fazer o painel parecer normal.

A próxima ocorrência equivalente é recuperada pelo fluxo normal antes de
chegar ao guard de prioridade; o Watchdog permanece fallback independente.
Isso não torna automaticamente recuperável qualquer erro de commit sem prova:
falha dura, ownership divergente ou dispatch incerto continua BLOCKED_SAFE.
Não ampliar a allowlist genérica de recovery deste wrapper.

## Testes e publicação

Fixtures executam o worker real com I/O simulado: hold SELL confirmado,
duas invocações, motores irmãos, ACK ausente, TP sem proteção, CAS503,
permissão negada, orçamento novo, preservação de TPs e controle oficial.
PGlite descartável prova que crítico próprio bloqueia a alocação atomicamente
e que crítico de outro engine não amplia o blast radius; código SQL REAL
não é executado para testes. Relatórios exportam a regra de settlement.

Sem migration/RLS, mudança de infraestrutura ou restart nativo. Publicar por
GitHub/main/Vercel e fechar somente após reconciliação e Watchdog atuais.
Evidências privadas: `docs/evidence/coinops-thyely-incident-20261105-*`.
