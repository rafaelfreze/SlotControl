# Marco imutável de reset e replay histórico — 22/10/2026

## Incidente comprovado

Produto CoinOps, Production/REAL, projeto Supabase `otdfpmsegjxpqrzisfmi`, schema
`coinops`. Escopo: Caixeta, BTCBRL, Executor 01 (`46.101.104.48`).

- Operator: `d508bb3e-5a1d-4579-bd7a-de171c118d25`.
- Account: `ba2bfbfe-b0ca-495b-957f-5097b019f172`.
- Engine: `9f7479b6-e803-4e7c-8bbb-fca0e9ba3e5b`.
- Run: `d4dfd8f9-fff0-45cb-8a0d-52a7701d7ba3`.
- Predecessor: `64b267d0-3897-4783-a07e-69c427472f81`, COMPLETED desde 02/10.
- Alerta: `3c9f6b39-6aad-497c-9e0b-63766b29ac40`, iniciado em
  22/10 às 11:24:26 UTC (07:24:26 Cuiabá).
- Incidente Watchdog: `b2e2560f-84fa-45fd-b332-d96accfe0f58`, detectado às
  11:24:46 UTC. OPEN/BLOCKED, sem recovery em andamento na investigação inicial.
- Código/root: `COINOPS_LIVE_EVENT_PERSIST_FAILED`, stage `AUDIT_EVENT`.
- Diagnóstico: `READBACK / READBACK_MISMATCH`, tentativa 1, tipo `RESET_RECOVERED`,
  chave `RESET_RECOVERED:64b267d0-3897-4783-a07e-69c427472f81`.

O evento dessa chave já existia desde `2026-10-02T04:23:07.416098Z`, com
`open_positions=1`, `resident_buy_count=1` e predecessor exato. Em 22/10 o motor
possuía cinco posições OPEN. O código recalculava esses contadores e tentava
reemitir o mesmo evento em todo tick saudável, mesmo sem alerta RESET_FAILED
aberto. Sob resposta incerta, o comparador estrito via o primeiro snapshot e
recusava o payload atual divergente. Reprodução offline confirma esse caminho.

Isso é uma violação do contrato do marco histórico pelo produtor, não autorização
para ignorar divergências. A correção de auditoria de 21/10 revelou o replay que
antes era aceito silenciosamente pelo `ignoreDuplicates`. Sua cobertura não
incluía a mudança legítima de contadores entre ticks do mesmo sucessor.

O diagnóstico mismatch não reteve a resposta de transporte anterior. Portanto
não atribuir retrospectivamente timeout ou 503. A causa do replay é comprovada;
o motivo upstream da resposta incerta permanece não observado.

## Estado financeiro anterior à correção

Leituras autenticadas do próprio Executor 01 às 11:31 UTC e ledger escopado
confirmaram cinco TPs SELL de 0,00004 BTC e uma NEXT BUY de 0,00005 BTC, todos NEW,
sem execução parcial. IDs exatos coincidiram: TPs `2343762353`, `2347164028`,
`2347246405`, `2349238239`, `2368590541`; NEXT BUY `2368590783`. Todos pertencem
ao namespace `C2-81125246f8-`. Os 25 slots estão íntegros, sem fills, decisões
financeiras ou reservas de dispatch pendentes. Executor/credencial/Binance
saudáveis; os outros 15 motores permaneceram HEALTHY.

Não criar/cancelar ordens para testar, não alterar estratégia ou capital, não
limpar gates/alertas via SQL. O bloqueio atual já é restrito ao engine afetado.

## Protocolo de marco histórico

1. No fluxo canônico, após proteção financeira normal, ler o marco pelo escopo
   completo e chave do predecessor, com lease e a política GET-only existente:
   dois conjuntos de até 5s, separados por 250ms. Falha transitória usa checkpoint
   normal tipado `ledger/reset_recovery_milestone`, sem repetir trading; erro duro
   ou payload inválido não herda retry. Ausência exige resposta completa válida.
2. Marco existente exige tipo RESET_RECOVERED, slot nulo, identidade integral,
   predecessor exato, timestamp válido e payload estritamente conhecido:
   predecessor + contagem histórica inteira válida + exatamente uma BUY residente.
3. Marco válido existente não é reemitido nem atualizado. A contagem histórica
   não precisa ser igual à quantidade de posições observadas hoje.
4. Ausência confirmada permite a primeira emissão pelo helper idempotente
   existente. Resposta incerta ainda exige comparação estrita do mesmo payload;
   nunca repetir trabalho financeiro, reset, gain, cancelamento ou envio.
5. Erro de leitura, identidade estrangeira, payload extra/inválido, predecessor
   divergente ou tempo impossível permanecem fechados. Não usar cache local
   entre invocações nem inventar ausência quando uma leitura falha.

## Recuperação estreita do legado

READBACK_MISMATCH genérico continua não recuperável automaticamente. Somente o
diagnóstico tipado exato de RESET_RECOVERED pode ser candidato, nunca um erro
duro, outro tipo de evento ou um wrapper sem prova.

Sob lease do motor: provar marco histórico íntegro e anterior ao incidente,
predecessor COMPLETED e único sucessor com identidade canônica. Repetir essas
provas antes/depois das leituras financeiras, juntamente com RECONCILED novo e
fresco posterior ao incidente, Binance × ledger, TP, NEXT BUY, slots, caps,
mensal/configuração, zero fills/decisões/dispatches pendentes e CAS do mesmo
incidente incluindo todos os campos audit_*. Qualquer falha mantém BLOCKED_SAFE
somente nesse engine. Não sobrescrever o primeiro evento nem sua data.

Uma indisponibilidade futura da leitura do marco tem tratamento distinto:
`COINOPS_LIVE_LEDGER_READ_STALE`, root `COINOPS_LIVE_LEDGER_READ_UNAVAILABLE`,
stage `AUDIT_EVENT` e caminho `ledger/reset_recovery_milestone`, todos exatos.
Nesse caso, GET completo pode provar marco válido ou ausência confirmada; ambas
as observações são repetidas, junto às provas de linhagem/financeiro/reconciliação
sob lease/CAS. Isso evita prender para sempre um sucessor cujo primeiro marco
ainda não havia sido emitido. A recuperação não cria esse marco: eventual primeira
emissão só ocorre no próximo fluxo normal. Leitura falha/incompleta jamais vira
ausência, e READBACK_MISMATCH continua exigindo marco válido anterior ao incidente.

Após retomada oficial, o Watchdog independente precisa confirmar HEALTHY e
encerrar o incidente. A assinatura já foi classificada automaticamente como
RECURRENCE_REGRESSION/HIGH, preservando histórico e a versão anterior. Registrar
esta correção e seus testes somente depois do deploy e da prova financeira final.

## Validação/publicação

Fixtures isoladas cobrem marco antigo com uma posição versus estado atual com
cinco, ausência e primeira emissão, ACK perdido, crash/restart, identidade e
predecessor incorretos, segundo sucessor, payload extra/inválido, tempo futuro,
lease perdida, prova financeira pendente e incidente alterado. Comparador genérico
de auditoria continua com testes negativos de payload divergente.

Relatórios novos usam contrato 29; snapshots antigos ficam intactos. Sem migration,
RLS nova, infraestrutura paga ou mudança de cron. Gerar fingerprint financeiro web
e verificar o grafo nativo antes de decidir se existe necessidade real de rollout.
Publicar uma única release GitHub/main/Vercel e observar o cron normal, sem testes
financeiros artificiais em Production.

Este documento registra causa, protocolo e evidências iniciais. Não constitui
declaração de fechamento antes da validação real posterior ao deploy.

Validação offline concluída antes de publicar:

- Marco/auditoria: 32/32 testes; elegibilidade/retomada: 60/60.
- Fluxo normal/observação: 18/18; reset/capital/transporte: 22/22.
- Relatórios: suíte de 194 testes aprovada; após adicionar o caso de ausência
  confirmada, arquivo afetado novamente aprovado com 6/6 testes.
- Lint global, typecheck e build Next.js aprovados. O build restrito inicialmente
  encontrou EPERM em diretório gerado; o mesmo build isolado foi concluído com a
  permissão necessária, sem credenciais produtivas e sem alteração de fonte.
- Fingerprint web `0c960efe25e150ea0ed8b1af7cc73fef877bd05864e75c8c108b4b7dc584657f`,
  110 arquivos, verificado. Grafo nativo: 31 arquivos, fingerprint preservado
  `a2aac367f17666b84b5ffc3c75be72d22d0d511cde5ea3581b5db952900445e0`.
  Sem necessidade de reinício dos executores.
