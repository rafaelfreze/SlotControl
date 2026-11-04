# Prioridade acumulada: igualdade JSONB e recuperação de replay

Incidente Pedro/SOLBRL, Executor01, em 04/11/2026 às20:29UTC. Engine
`9ea63a7d-504b-4712-b8e8-204734ca9379`, run
`aede3a8b-ad73-4c6a-9552-1f8d2e275cb4`, incidente
`9e28277c-f216-4c77-bcaf-8d03673fcd81`.

`JSON.stringify` comparava objetos semanticamente iguais com a ordem diferente
de propriedades devolvida pelo JSONB. O worker atualizava repetidamente o
checkpoint mensal, reapresentando a chave imutável já persistida com outro
`observed_at`. Um readback incerto detectou corretamente o payload diferente:
`COINOPS_LIVE_EVENT_PERSIST_FAILED / ATH_TRANSITION / READBACK_MISMATCH /
MONTHLY_PRIORITY_REFRESHED`. O diagnóstico não comprova o erro de transporte
original; não presumir503. O Watchdog bloqueou somente esse engine; o worker
continuou reconciliando e protegendo posições.

## Correção

Comparação estrutural integral ignora apenas a ordem das propriedades JSON;
campos ausentes, extras ou valores diferentes continuam mudanças reais. A chave
de auditoria conserva o hash histórico com ordenação explícita dos campos da
meta. Não altera metas, prioridade, preços, capital, spacing, ATH, slots ou TPs.

A recuperação automática é restrita ao diagnóstico tipado exato acima, com
uma ou duas tentativas e HTTP/provider explicitamente nulos. Alertas legados
sem `audit_event_key` exigem derivar a chave do estado canônico atual; chaves
presentes devem coincidir. Outro estágio, evento, erro duro ou mismatch continua
fechado. Não ampliar o comparador genérico de persistência.

O reconciliador deve provar duas vezes, sob a lease e CAS usuais:

1. Meta recalculada no ledger igual à meta e competência do run.
2. Evento imutável único, no escopo completo e chave exatos, anterior ao
   incidente; checkpoint sem reancoragem e com níveis preservados.
3. Semântica integral igual entre evento e checkpoint salvo. Apenas horários
   de observação e competência anterior podem refletir a repetição; ambas as
   competências anteriores são válidas e não futuras.
4. Novo RECONCILED fresco, posterior ao incidente, sem preencher o minuto antigo.
5. Binance×ledger, ownership, posições cobertas por TP, uma NEXTBUY, caps,
   configuração e slots íntegros; decisões financeiras assentadas e nenhum
   dispatch pendente antes e depois das observações externas.
6. Mesmo incidente e diagnóstico no CAS final. Alteração concorrente ou falha
   mantém/recoloca apenas o engine em BLOCKED_SAFE.

Nenhuma ordem é enviada ou cancelada pela recuperação. O fluxo oficial libera
o gate; o próximo cron decide entradas normalmente e o Watchdog confirma o
encerramento. Preservar o evento original e histórico de ganhos. Sem migration,
novo cron, infraestrutura ou restart de executor: a mudança é server-side web.

## Verificação

Regressões: `monthly-level-preservation.test.ts`, `monthly-priority-audit.test.ts`,
`live-read-recovery-server.test.ts`, `live-read-recovery.test.ts`,
`live-audit-event.test.ts` e relatórios. Cobrem ordem JSONB, alteração real,
25/50/100, chave histórica, escopo estrangeiro, evento ausente/duro, TP ausente,
dispatch/decisão pendentes, dupla prova, crash, fill concorrente, lease e CAS.
Todos os transportes de ordens dos testes são simulados e proibidos no resume.

Fechamento exige leitura real após READY: gates abertos, alerta resolvido pelo
fluxo oficial, incidente recuperado, slots/TP/NEXTBUY e demais engines preservados.
Os arquivos privados `docs/evidence/coinops-pedro-incident-20261104-*` conservam
as provas do atendimento, sem credenciais.
