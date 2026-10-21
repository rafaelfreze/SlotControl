# Auditoria final idempotente e recuperação comprovada — 21/10/2026

## Incidente real e evidência anterior à correção

- Produto CoinOps, Production/REAL, Supabase `otdfpmsegjxpqrzisfmi`, schema `coinops`.
- Executor 01 (`46.101.104.48`), conta Thyely, mercado SOLUSDT.
- Account `5580c011-6ff1-44bd-b568-85932b424ceb`.
- Engine `990bc1b9-4ff8-46c5-a7b2-7db793a21e4a`.
- Run `26986505-fb6b-44cf-9923-f35cb8dcf5c3`.
- Alerta `215a73eb-81ac-48cd-b405-259b1d519108`:
  `COINOPS_LIVE_EVENT_PERSIST_FAILED`, stage `AUDIT_EVENT`, source `ENGINE`.
- Watchdog incidente `1ec3bec9-554e-4329-8687-b1bc6cb16c16`, aberto às
  13:28:46 UTC (09:28:46 em Cuiabá). Detectado BLOCKED, sem tentativa de recovery.
- Vercel `/api/cron/live-execution`, request
  `drkrl-1792589284205-12a29440a3c3`, deployment `dpl_4FY2YZw4ec49N8nDWhyH5V4YZxXK`,
  confirmou apenas um FAILED entre 16 runs. Os outros 15 estavam saudáveis.

A chave `RECONCILED:2026-10-21T13:28` está ausente; o evento de reset antigo já
existia. O upsert final de RECONCILED foi o ponto que falhou. Os minutos 13:29
em diante voltaram a persistir com `next=KILL_SWITCH`, e `last_error` voltou a
null, mas o gate de novas entradas permaneceu fechado porque este wrapper não
era elegível para recuperação automática.

Às 13:34 UTC, leitura autenticada de Binance × ledger confirmou seis TPs e uma
NEXT BUY, com os mesmos orderId/clientOrderId, quantidade e preço. Às 13:40:46:
25 slots, zero fills pendentes, zero decisões financeiras incompletas e zero
reservas de dispatch sem ACK; reconciliação 13:40:21. O processo do executor e a
conexão Binance estavam saudáveis. Nenhuma ordem foi criada/cancelada para teste.

## Causa estrutural, sem inventar o erro upstream

O wrapper antigo executava um único upsert e convertia qualquer resposta de erro
em `COINOPS_LIVE_EVENT_PERSIST_FAILED`, descartando HTTP e provider code. Não
existia observação do mesmo evento após resposta incerta nem retry limitado
apenas da persistência idempotente. Depois, faltava runbook automático para um
gate residual após nova reconciliação comprovadamente íntegra.

Não é possível afirmar retroativamente se o provider original retornou timeout,
503, falha de transporte ou outro erro. A ausência dessa evidência permanece
explícita. A correção resolve a fragilidade comprovada do fluxo, sem classificar
UNKNOWN como transitório nem ampliar timeout do trading.

## Persistência imutável

`live-audit-event.ts` captura uma única vez escopo, run_id, event_key, tipo,
slot e JSON do evento. Utiliza a unicidade existente `(run_id,event_key)` e
`ignoreDuplicates: true`, sem UPDATE de eventos ou alteração de grants/RLS.
O contrato do SDK foi conferido na [documentação oficial de upsert](https://supabase.com/docs/reference/javascript/upsert).

No máximo duas tentativas limitadas, com renovação de lease quando aplicável.
Após resposta transitória/incerta, GET do evento por identidade completa antes
de qualquer repetição. ACK perdido com linha exatamente correspondente conclui
sem novo write; linha ausente permite somente a segunda tentativa do mesmo
payload/chave quando a falha é tipada como transitória. Linha estrangeira,
payload divergente, permissão/schema/constraint e observação inconclusiva não
autorizam retry financeiro nem encerramento cego do incidente.

Provider code/status, fase, tentativas e razão sanitizados ficam disponíveis
para alertas/relatórios futuros. Não registrar tokens, mensagens arbitrárias
do provider ou payloads financeiros no log.

## Recuperação no reconciliador canônico

A elegibilidade exige código/root exatos em `AUDIT_EVENT`; outro estágio não
herda este mecanismo. Metadados duros, inválidos ou divergentes não se tornam
transitórios. Wrapper legado sem diagnóstico não prova o motivo histórico:
exige prova de segurança atual mais forte.

Sob o lease do mesmo engine/run:

1. Reconciliação completa atual, Binance × ledger, ownership e TPs íntegros.
2. Novo RECONCILED persistido depois do incidente, fresco e coerente com o run;
   nunca preencher o minuto histórico ausente com um estado observado depois.
3. Slots, ganhos/metas, caps, configuração e parents válidos.
4. Nenhuma ordem preparada/incerta, fill pendente, decisão financeira incompleta
   ou dispatch sem ACK; conferir antes e depois das leituras externas.
5. Mesmo incidente único, código/timestamps/diagnóstico inalterados no CAS final.
6. Retomada pelo fluxo oficial, evento de recuperação auditado e confirmação
   HEALTHY pelo Watchdog independente. Não executar SQL para limpar gates.

Falha de qualquer prova conserva o bloqueio somente no engine afetado. Não
modificar slots, capital, gain, spacing, TPs ou ordens de outros motores. O
Watchdog continua sendo fallback: uma observação transitória de auditoria que
converge dentro do protocolo não deve bloquear o happy path nem disparar push.

## Validação e publicação

Testes usam fixtures/transportes simulados e não enviam ordens reais. Cobrir:
ACK perdido, retry da mesma chave/payload, leitura inconclusiva, erro duro,
conflito de identidade, motores irmãos/cross-shard, lease perdido, auditoria
posterior/fresca, timestamp futuro, estágio errado e decisões/dispatch pendentes.

Relatórios novos usam contrato 28 e preservam diagnóstico/ausência histórica em
CSV/JSON. Snapshots antigos não são reescritos. Nenhuma migration é necessária.
Atualizar o fingerprint financeiro web pelo gerador oficial; isso não certifica
perfis de 50/100 slots e não altera a quantidade da frota LIVE.

Mudança apenas server-side web não exige reiniciar VPS quando o grafo nativo
do executor permanece igual. Publicar uma vez por GitHub/main, confirmar Vercel
READY e observar a recuperação pelo cron normal antes de encerrar o incidente.

Validação offline concluída nesta entrega:

- Persistência imutável: 17/17 testes.
- Elegibilidade e retomada sob lease/CAS: 53/53 testes.
- Regressões de capital, monitor, observação e pausa: 47/47; observação ampliada
  posteriormente para 15/15, incluindo resposta perdida e retry sem replay do trading.
- Relatórios: 189/189, incluindo o novo contrato e preservação histórica.
- Lint, typecheck e build Next.js aprovados. Avisos preexistentes de CSS/SDK Edge
  não foram alterados incidentalmente.
- Fingerprint financeiro web verificado pelo gerador oficial; grafo nativo e
  release dos executores permanecem inalterados. Nenhuma migration/RLS alterada.

O fechamento operacional depende da evidência posterior ao deploy, não dos testes
offline. O evento histórico ausente permanece ausente; somente os novos checkpoints
podem comprovar o estado financeiro atual.
