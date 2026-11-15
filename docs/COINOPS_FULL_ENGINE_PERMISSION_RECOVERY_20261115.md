# CoinOps — recuperação de leitura de permissões com todos os slots OPEN

## Incidente e diagnóstico

CoinOps REAL, Supabase `otdfpmsegjxpqrzisfmi`, schema `coinops`.
Thyely/SOLBRL, engine `fa551904-15da-4e17-8259-b0a76e206fac`,
run `53d2c2ef-a37f-48ee-8aff-4b3843f73e27`, Executor 01.
Em 15/11/2026 às 12:08:34.577 UTC, um READ_STATE retornou
`EXECUTOR_PRODUCTION_PERMISSION_DENIED` / HTTP 503 do executor, na etapa
ASSERT_PROTECTION. Watchdog detectou às 12:08:46 e manteve o incidente aberto.
O journal não conserva o HTTP/código Binance dessa rejeição; não atribuir a
timeout, rate limit, revogação de chave ou erro de autenticação sem evidência.

Às 14:24 UTC, health autenticado comprovou permissões seguras, IP e runtime
oficiais, zero claims pendentes e 25 TPs próprios NEW. O ledger tinha 25/25
slots OPEN e reconciliação normal, terminando em KILL_SWITCH local.
O bloqueio persistia por dois limites do recovery: ASSERT_PROTECTION não era
elegível e a prova exigia exatamente uma BUY, impossível com todos os slots OPEN.

## Correção e limites

Estender a elegibilidade somente ao par exato ASSERT_PROTECTION_FAILED /
ASSERT_PROTECTION com root EXECUTOR_PRODUCTION_PERMISSION_DENIED.
Isso não torna a rejeição retryable nem comprova transiência histórica.
O resume canônico continua exigindo permissões atuais completas, health,
ownership, ledger integral, TP de cada posição, caps, metas, estratégia estável,
lease e CAS do único incidente. Pausa intencional não retoma por essa regra.

A prova de uma BUY NEW permanece válida. Somente nessa nova etapa também se
aceita zero BUY se todos os N slots físicos estiverem OPEN com quantidade
executável e houver N TPs NEW próprios e exatamente coincidentes na Binance.
N deriva da configuração canônica, validada pelo módulo de topologia; não
inferir quantidade pela consulta. Slots faltantes, repetidos, posição parcial,
TP ausente, PREPARED, UNKNOWN, fill não reconciliado ou ordem recente impedem
a recuperação. Não criar uma BUY para satisfazer um indicador.

Todas as ordens devem ser anteriores ao incidente em pelo menos 90 segundos.
Decisões recentes/não concluídas e dispatches sem ACK bloqueiam. Repetir a
leitura financeira, a proteção de TPs e a prova de decisões/dispatches perto
do CAS, ainda sob lease. Não repetir POST ou cancelamento como retry.
O worker normal reconcilia; o cron usa VERIFIED_READ_RECOVERY; o Watchdog
confirma independentemente e encerra o incidente com histórico preservado.

## Validação e publicação

Fixtures isoladas cobrem 25/50/100 slots, zero BUY com todos OPEN, rejeição de
topologia incompleta, identidade/quantidade/preço divergentes, permissão atual
insegura, fill parcial, dispatch tardio, decisão tardia, CAS alterado e isolamento.
As funções de envio/cancelamento falham explicitamente se chamadas nos testes
do resume. Nenhuma operação REAL é usada como teste.

Mudança apenas web: nenhuma migration, RLS, secret, perfil financeiro ou runtime
nativo precisa mudar. Publicar por Git/main e integração Vercel. Após deploy,
aguardar o cron normal, verificar evento LIVE_RESUMED com fonte
VERIFIED_READ_RECOVERY, incidente RECOVERED, gates locais abertos, 25 TPs
originais intactos e ausência de BUY quando não existir slot livre. Preservar
os demais engines e confirmar Watchdog dos dois executores.

Ver também `COINOPS_PERMISSION_READ_RECOVERY_20261011.md`.

Validação local da release: 117 testes direcionados PASS (recovery puro,
resume sob lease/CAS, observação, transporte, erros e evidência de permissões),
typecheck PASS, lint direcionado PASS e build PASS. Warnings preexistentes de
Supabase no Edge Runtime e CSS vendor não impediram a compilação. Manifesto
financeiro regenerado e validado; grafo nativo não alterado.
