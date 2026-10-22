# CoinOps — relatórios auditáveis (runbook histórico)

Contrato atual v29: publica `reset_recovered_milestone_persistence`,
`reset_recovered_mismatch_guarded_recovery` e
`reset_recovery_milestone_observation` como `CURRENT_CODE_CONTRACT`.
`RESET_RECOVERED:<previous_run_id>` é marco histórico imutável first-writer por
successor run, não snapshot corrente. Um GET completo valida escopo exato,
tipo, slot nulo, vínculo anterior e shape dos três detalhes
`previous_run_id`, `open_positions` e `resident_buy_count`: contagem inteira
de 1 até `slot_count`, uma BUY residente e `observed_at` entre a criação do
successor e agora. Marco existente válido dispensa nova escrita; sua contagem
antiga não é comparada à atual. Exemplo: uma posição no marco de 02/10 e cinco
posições no estado atual são fatos de instantes distintos, não divergência
financeira por si só. Nunca alterar o marco, renovar seu horário ou reemitir a
contagem atual sobre a mesma chave. Ausente, usa o INSERT idempotente normal;
o helper genérico continua exigindo igualdade integral no readback incerto.
O GET usa a política compartilhada do ledger: dois conjuntos completos de até
5s, intervalo de 250ms e lease preservada. Indisponibilidade transitória tipada
usa checkpoint normal, sem confundir erro com ausência confirmada ou permitir
INSERT alternativo. Exaustão stale só qualifica com código
`COINOPS_LIVE_LEDGER_READ_STALE`, root
`COINOPS_LIVE_LEDGER_READ_UNAVAILABLE`, `stage=AUDIT_EVENT` e
`read_path=ledger/reset_recovery_milestone`. Esse ramo exige marco válido ou
ausência comprovada por GET completo nos dois passes, além de lineage,
RECONCILED fresco e finanças atuais comprovados antes/depois, lease e CAS.
Ausência por erro, fonte incompleta ou leitura inconclusiva nunca é prova.
Recovery não insere o marco ausente: a primeira emissão ocorre no próximo tick
normal protegido, se aplicável. Se existente, admite marco posterior ao
incidente de leitura. Não herda aprovação genérica de stale e não flexibiliza
a colisão histórica abaixo, que continua exigindo marco válido anterior.

Recuperação da colisão histórica é exceção estreita: código/root exatos
`COINOPS_LIVE_EVENT_PERSIST_FAILED`, `stage=AUDIT_EVENT`, `audit_phase=READBACK`,
`audit_reason=READBACK_MISMATCH`, `audit_event_type=RESET_RECOVERED`, chave com
o UUID anterior exato, tentativas inteiras 1..2 e HTTP/provider explicitamente
null. Exige marco válido anterior a first_seen/last_seen do incidente,
predecessor COMPLETED com criação <= conclusão <= criação do successor,
successor ACTIVE único com id/criação/reset_idempotency_key exatos e chave
`RESET:<previous_run_id>:`. Exige também RECONCILED posterior fresco e todas as
provas financeiras atuais, decisões/dispatches assentados duas vezes e CAS sob
lease. Erro genérico, shape/identidade/lineage ambígua, fill pendente ou estado
financeiro inconclusivo permanece BLOCKED_SAFE no engine afetado. Relatório
não executa esse protocolo e não promove histórico divergente a PASS. Exporta
o marco antigo, o snapshot atual, os detalhes tipados do alerta e eventual
`LIVE_RESUMED` como fatos separados em CSV/JSON; não deduz recovery sem evento
persistido. A regra não é autorização financeira nem certificação de runtime.
O pacote mantém 27 arquivos e preserva snapshots v28/anteriores. Ver
`COINOPS_RESET_MILESTONE_RECOVERY_20261022.md`.

Preserva v28: publica `final_audit_event_persistence` e
`audit_event_guarded_recovery` como `CURRENT_CODE_CONTRACT`, sem certificar
execução histórica, causa upstream ou recuperação pela mera presença da regra.
A persistência final usa identidade operator/account/engine/run/shard/chave
exata, payload capturado imutável e observed_at já persistido preservado: até
dois conjuntos de escrita/readback, com orçamento de 5s por conjunto, escrita
limitada a 2,5s e intervalo de 250ms; a renovação de lease participa do orçamento.
Happy path tem um upsert sem GET adicional. Há GET de readback antes de qualquer
repetição após ACK incerto. O readback
deve confrontar integralmente o mesmo registro; divergência, falta de prova,
permissão/schema ou ambiguidade permanecem fail-closed. Isso não é retry de
gain, reconciliação financeira, BUY/TP/NEXT BUY, create/cancel ou decisão.

Recuperação guardada qualifica somente `COINOPS_LIVE_EVENT_PERSIST_FAILED`
no estágio `AUDIT_EVENT` e root exato, após novo `RECONCILED` fresco e
persistido depois da falha no mesmo escopo. Exige prova integral de ledger,
slots, ordens próprias/TP/NEXT BUY, mensal, caps, configuração, proteção e health,
além de decisões financeiras assentadas e zero dispatch pendente comprovados
duas vezes, antes/depois das provas, sob lease e CAS do incidente inalterado.
A observação tem no máximo 150s, sucede first_seen/last_seen do incidente e
antecede last_reconciled_at em até 120s; a chave do minuto real admite até 65s
após seu início e 1s de skew. `next=KILL_SWITCH` e `strategy_version` exata
mantêm entradas protegidas durante a prova. Metadados `audit_*` presentes
participam do CAS; o ramo transitório tipado exige tipo RECONCILED/RESET_RECOVERED
e reason/HTTP/provider estritamente transitórios. A única exceção a mismatch
é o marco RESET_RECOVERED comprovado acima; mismatch genérico continua fechado.
Legado sem metadados não vira
transitório por inferência: apenas a prova financeira atual pode qualificá-lo.
Não recria evento histórico ausente, fabrica freshness nem libera outro
engine. O relatório exporta somente evidência persistida: nunca executa recovery
ou consulta/cancela ordens para produzir um PASS. Histórico sem diagnóstico do
provider conserva `UNKNOWN`/null; nunca recebe 503 ou outra causa presumida.
Os detalhes tipados futuros conservam `audit_phase`, `audit_reason`,
`audit_event_type`, `audit_event_key`, `audit_attempts`, `audit_http_status` e
`audit_provider_code`, quando conhecidos, em `LIVE_EXECUTION.csv`/JSON. O pacote continua com 27
arquivos, sem dataset, polling ou coleta extra. Snapshots anteriores conservam
sua versão original e não são reescritos.

Preserva v27: publica `large_engine_owned_observation_protocol` com
`CURRENT_CODE_CONTRACT`, sem inferir execução histórica ou capacidade. Somente
N>25 usa `/v1/observe-order` GET-only para observar ordem/fills coerentes com
ownership exato; quantidade, nocional e lado devem concordar. Resposta ausente,
fill/cancel ambíguo e divergência continuam fail-closed. Diagnósticos transitórios
tipados preservam `details.read_path=/v1/observe-order`, tentativas e HTTP nos
alertas/eventos já exportados; não há novo dataset, polling ou coleta de custo.
Cotação BNB com TTL60s é apenas para fees, nunca cache de autorização de saldo,
ordens, filtros ou permissões. Motores25 conservam o protocolo anterior.
Preserva v26: topologia por engine e progresso cooperativo monotônico, sem
fabricar `last_reconciled_at`, e Watchdog RECONCILING limitado/protegido.
Certificação de capacidade exata, fleet parity e admissão continuam separadas
do protocolo funcional; regra presente não significa PASS de carga.

Preserva v24: pausa intencional de novas BUY, sem interromper TP/fills/gains
das posições antigas. Exporta `intentional_entry_pause_protection` e
`paused_account_home_visibility`. `LIVE_PAUSED` e `RECONCILED` continuam em
`LIVE_EXECUTION.csv`/JSON com allowlist de proteção. Pausa não é reset, não
retoma automaticamente nem equivale a HEALTHY; preferência Home não altera
ledger ou Watchdog. O check `PAUSED_ENTRY_PROTECTION_EVIDENCE` confronta somente
atestação persistida e ledger, nunca certifica Binance atual/admission/retomada.
Preserva v23: reserva física BNB Spot antes de BUY, HOLD/AVAILABLE por
engine, TP/fills preservados e receipt HMAC somente para rejeição pré-POST
comprovada. Exporta `physical_spot_bnb_fee_reserve`; insuficiência, reposição e
prova de não envio não equivalem a fill/gain. Ver
`COINOPS_BNB_FEE_RECOVERY_20261011.md`. Preserva v22: checkpoint/gate/configuração e cap compartilham a política
GET-only do ledger. Exporta `strategy_config_observation_retry`, diagnósticos
sanitizados e a proibição de retomar edição pendente/ambígua. Ver
`COINOPS_CONFIG_READ_RECOVERY_20261007.md`. Preserva v21: inclui target e totais mensais REAL no snapshot GET-only
limitado, sem zerar ganhos por falha de consulta. Recuperação do legado exige
ledger mensal válido, Binance/TP/caps e CAS sob lease. Ver
`COINOPS_MONTHLY_LEDGER_RECOVERY_20261007.md`. Preserva v20: observação do ledger com retry read-only limitado, diagnóstico
sanitizado e retomada após prova integral sob lease. Ver
`COINOPS_LEDGER_READ_RECOVERY_20261007.md`. Preserva o contrato v19: saldo Spot físico antes de BUY, HOLD/AVAILABLE preservando
TP/fills e rejeição pré-POST assinada. Compatibilidade histórica exige journal
do runtime fixado, claim exato, fence e GET; nunca DELETE manual de claim.
Ver `COINOPS_QUOTE_BALANCE_RECOVERY_20261007.md`. Retry read-only com checkpoint, diagnósticos de origem e
TRADING_FLOW_OWNER ficam nos eventos/alertas exportados. Ausência de atribuição
é UNKNOWN, não 0%. Registry e SLO administrativos: `COINOPS_TRADING_RELIABILITY_20261005.md`.

Os defaults BTC 2%/2% e SOL 3%/3% de 09/10/2026 não mudam o formato v22:
`REGIME_ATH.csv` continua exportando `normal_spacing_pct` e `post_ath_spacing_pct`
do perfil persistido, e `LIVE_EXECUTION.csv` conserva `entry_spacing`, gain,
versão e evidência/snapshot das ordens. Não preencher esses campos com defaults
quando a configuração real divergir, nem reinterpretar ordens históricas.
Rafael possui exceção normal intencional confirmada em 09/10/2026: BTC 1% e
SOL 1,5%, com pós-ATH 2%/3%. Exportar esses valores reais separadamente; a
diferença entre regimes não representa por si só erro ou falha de padronização.
Os checks ATH históricos de Top 15/Reserve não certificam uma transição LIVE
não observada; preservar WARNING onde a evidência esteja ausente. Procedimento:
`COINOPS_SPACING_STANDARDIZATION_20261009.md`.

Contrato v17 preservado: recuperação de ENTRY não enviada exige prova síncrona
pré-fetch ou fence durável + ausência de claims + GET exato, nunca timeout ou
ausência na exchange isoladamente. Exporta a regra `unsent_entry_recovery` e
os eventos `ACCOUNT_ORDER_NOT_SUBMITTED` sem tratar não envio como fill.
Procedimento: `COINOPS_UNSENT_ENTRY_RECOVERY.md`.

O contrato efetivo em `apps/web/lib/coinops-reports/filters.ts` é agora
`report_version = 29`. A versão 16 acrescentou identidade e metadados de isolamento por engine/shard; publicação depende dos gates da release, não deste documento. A versão 14 registra meta mensal como piso: 25/25 atingidos voltam à fila elegível sem reset de gains; auditoria de entradas usa os 25 saldos assinados conhecidos no instante. O texto abaixo documenta a evolução histórica da versão 3;
afirmações antigas de LIVE bloqueado não descrevem a operação atual.
Na versão 13, `NEXT_BUY_CAPITAL_REFRESH_AUDIT` confronta somente a cadeia persistida
de atualização da NEXT BUY por capital aplicado: plano, confirmação, cancelamento
zero-fill reconciliado e nova ordem ENTRY com mesmo preço/run/slot/operação.
O export continua somente leitura: não inicia a substituição nem consulta/cancela
ordens para construir evidência. Não certifica o estado Binance atual nem a
preservação global de TPs por mera ausência de alerta.
Na versão 12, o check `STRATEGY_PRICE_INVARIANT` marca FAIL para alerta LIVE
ativo de preço estratégico e WARNING na ausência desse alerta: o pacote não
inclui uma leitura Binance direta e contemporânea, portanto não inventa PASS.
O alerta histórico resolvido permanece exportado em `LIVE_EXECUTION.csv`.
Na versão 11, `APORTES.csv` e o dataset `contributions` exportam o ledger
imutável de ajustes LIVE por conta, motor e slot físico, com origem/moeda,
valor nativo, câmbio observado, estado OPEN, sequência, motivo e reversão.
Gain manual permanece separado de P&L de mercado; aporte não cria gain.
Fontes ausentes geram WARNING e nunca viram zero. A exportação é somente leitura
e não cria/cancela ordens Binance.

O nome histórico deste runbook é preservado. `report_version = 3` acrescenta a auditoria temporal de missed e a janela exata da Strategy Engine 4.1.0. A versão 2 introduziu decisões; pacotes anteriores preservam sua versão e não são reinterpretados.

Central: `/relatorios`. Legado de relatórios oficiais de ciclos: `/plano-crescimento/relatorios` (preservado, não misturado ao robô V1).

## Escopo e segurança

Produto CoinOps, Supabase `otdfpmsegjxpqrzisfmi`, schema `coinops`. A rota `/api/coinops-reports` autentica com `auth.getUser()`, resolve produto/tenant/usuário no servidor pela configuração CoinOps e pela estratégia visível sob RLS. Cada página de cada consulta filtra os três identificadores; uma linha de outro escopo aborta a exportação. O cliente não escolhe tenant nem usuário. A rota não usa service role, credenciais Binance ou serviços de execução.

Downloads são respostas privadas `no-store`, sem URL pública persistente ou arquivo bruto armazenado. O histórico da interface guarda somente os metadados dos downloads da sessão, sem valores financeiros. Não há duplicação do ledger nem das operações. Não há nova permissão para executar ordens. O relatório permanece somente leitura mesmo com motores LIVE operando no executor separado.

## Pacote e formatos

`coinops-report-AAAA-MM-DD_AAAA-MM-DD.zip` contém 17 CSVs numerados, `AUDITORIA_COMPLETA.json`, `manifest.json` e `RESUMO.md` (20 arquivos). Também há download individual e exportação separada de candles 1m completos.

CSVs têm BOM UTF-8, separador `;`, CRLF, campos escapados entre aspas, ponto decimal e proteção contra fórmula em células textuais. No Excel brasileiro, importar como UTF-8, delimitador `;`, e usar localidade Inglês (Estados Unidos) para números. Datas ISO. Persistência UTC; datas de filtro são dias inclusivos de `America/Campo_Grande`, transformados em intervalo UTC com fim exclusivo. Janela máxima: 366 dias. Campos sem evidência são vazios/null, não zero.

O ZIP usa DEFLATE/CRC32 e nomes fixos sem caminhos. O manifest informa SHA-256 e bytes de cada arquivo de conteúdo; não calcula hash de si próprio. Mesmo snapshot, filtros e versão produzem JSON/ZIP determinísticos. `generated_at` e dados novos mudam naturalmente o conteúdo entre gerações. `app_commit_sha` vem de `VERCEL_GIT_COMMIT_SHA`, quando disponível.

## Fontes e interpretação

- Shadow: configs, ciclos, slots, operações arquivadas, contas físicas, créditos imutáveis, eventos e candles do robô V1.
- Testnet: runs, slots, ordens e eventos, sempre marcados como **BINANCE TESTNET / FUNDOS FICTÍCIOS**. Ownership compara clientOrderId com a identidade determinística do run/slot/lado/revisão. IDs observados externamente não são suficientes para atribuir ownership.
- Real: conexão e reconciliações Production, intents com modo explicitado, regras e checklist de preparação. Ordens/trades manuais observados pela reconciliação não viram operações CoinOps. Nenhuma ordem real é criada pelo relatório.
- Créditos de compounding são ligados à operação por `operation_id`. A data econômica vem de `closed_at`, não de um `credited_at` de backfill. Preserva-se também a data da persistência.
- `physical_slot_number` identifica o slot físico; `logical_level` e `operation_sequence` identificam sua posição/reutilização. Ciclos incluem motivo de conclusão/reset e vínculo ao próximo ciclo quando persistido.

Snapshots atuais de slots/configuração/ordens não devem ser lidos como estado de uma data passada. Valores históricos só são reconstruídos com operações/créditos/eventos suficientes. Exportação por páginas não é snapshot transacional único: os instantes e a base da evidência são explícitos. Falha ou limite em uma fonte gera `incomplete_sources` e WARNING; não esconde registros nem certifica completude.

Um reset pode preservar um slot com status antigo sem arquivar um TP. `context_ended_at` registra o encerramento do ciclo, sem inventar venda, `closed_at` ou ganho. Esse snapshot deixa de compor posições ativas, capital comprometido e janelas de gatilhos depois do encerramento. Falhas de inicialização sem slots ficam nos erros históricos; não são tratadas como grades simultâneas em execução.

## Evidência adicionada nesta versão

Fase 4.1: `robot_v1_strategy_decisions` preserva a decisão antes do despacho, `strategy_version`, ambiente, ativo, ciclo/slot/operação, ação, prioridade, alvo, notional, razão, estado esperado/observado, despacho, ACK, conclusão, resultado, erro, latência e causa/correção quando disponíveis. Os campos são exportados no `15_ESTRATEGIA_DECISOES.csv` e no dataset JSON `decisions`. Fonte com falha é explicitamente incompleta; execuções históricas sem decisão/versão não recebem uma versão inventada. ACK Testnet e conclusão simulada Shadow são evidências diferentes.

Os checks incluem versão/paridade, decisão sem despacho/ACK, duplicação, posição sem TP, fill sem ordem, entrada MARKET inicial e `PRIORITY_REENTRY_MUST_BE_ARMED_BEFORE_LOWER_LEVEL`. Prioridade exige mercado observado, BUY residente e candidatos do mesmo ciclo. `LIVE_STRATEGY_PARITY_READY` só pode passar com os quatro contextos, versão única e evidência integral aprovada; nunca habilita LIVE. Ausência/recorte histórico ou pendência recente gera WARNING, não PASS. Falha comprovada permanece FAIL mesmo se outra fonte estiver incompleta.

Testnet registra `RECONCILIATION_STARTED`/`RECONCILIATION_FINISHED`, fonte FAST_REACTOR/WATCHDOG, intervalo esperado, duração, resultado e idade do checkpoint. O contrato atual é worker Testnet de 60 segundos e fallback de 300 segundos; Shadow permanece em 300 segundos. Detecção histórica de gaps só aplica 60 segundos a partir do primeiro evento comprovando a adoção, sem retroagir ao histórico de 5 minutos. Isso é polling serverless, não stream contínuo nem garantia de latência máxima.

`MISSED_LEVEL_DIAGNOSED` acrescenta causa, timestamps e versão da correção sem modificar o missed, saldo, gain ou inventar fill. Horário do fill na exchange, coleta e primeiro cruzamento de preço são conceitos separados; primeiro cruzamento não conhecido fica null. Diagnósticos são vinculados à ocorrência original, não contados como novos missed. A interface pode apresentar `Motor OK — ocorrências históricas preservadas` quando a causa histórica foi comprovadamente tratada e os invariantes/checkpoint atuais estão saudáveis. Histórico não esconde latência, erro ou evidência insuficiente. Os relatórios e a interface não executam recovery financeiro para gerar evidência.

### Auditoria temporal 4.1.1

`16_MISSED_TEMPORAL.csv` e o dataset temporal JSON preservam `occurred_at`, sua base e limite superior (`occurred_by_at`), `first_cross_at`, `detected_at`, `created_at`, versão no fato versus versão da detecção, `strategy_effective_at`, classificação, atividade, causa, resolução e fonte. Um TP antigo inicia a janela causal, mas sozinho não prova cruzamento antigo; um fill Testnet posterior em preço inferior ao alvo comprova o limite superior. Inserção após deploy não muda a classificação do fato. Campos sem evidência permanecem null.

Os checks `NO_NEW_ENGINE_MISSED_LEVELS`, `HISTORICAL_MISSED_NOT_ACTIVE` e `CURRENT_SLOT_STATE_NOT_OVERRIDDEN_BY_HISTORY` separam regressão, histórico resolvido e projeção operacional. OPEN/NEXT BUY/REENTRY WAITING/PLANNED/ACTIVE ERROR são categorias exclusivas; histórico é contador separado. `REENTRY_WAITING` de um slot legado MISSED sem ordem não significa BUY rearmada: aguarda ciclo futuro, mantendo estado bruto no detalhe.

O preset **Desde Strategy 4.1.0** começa exatamente em `2026-09-23T14:32:20.558Z`, primeiro processamento com o commit 4.1, e não no início do dia nem somente no READY (`14:31:34.826Z`). A janela inclui decisões, fills pela hora da exchange, ganhos por TP, reentradas, resets, novos missed, falhas de paridade, avisos de latência e invariantes. Créditos de ledger coletados tardiamente são apresentados separadamente de ganhos produzidos no período. Inventário histórico fica como contexto; não reprova sozinho o gate atual. Fontes incompletas/causa desconhecida continuam WARNING. Nenhum check habilita LIVE. Evidências e limites: [auditoria temporal](./COINOPS_PHASE_4_1_1_TEMPORAL_AUDIT.md).

A Fase 4.2 acrescenta `17_METAS_MENSAIS.csv` ao pacote v4, com meta BTC 7/SOL 2 por mês e slot físico, rank entre elegíveis, status e próximo reset em `America/Campo_Grande`. A contagem vem do ledger imutável, não de estados mutáveis de slots. Os 11 checks mensais e `LIVE_STRATEGY_PARITY_READY` registram falta de evidência como WARNING; o relatório não ativa LIVE. Ver [contrato 4.2](./COINOPS_PHASE_4_2_MONTHLY_GOALS.md).

A migration aditiva `20260923004502_add_report_runtime_observations.sql` cria observações de execução do motor e dos diagnósticos Testnet já existentes. Registra somente metadados permitidos, com identidade de escopo, versão e idempotência. RLS é obrigatória; usuários autenticados podem ler seu escopo, e somente o serviço pode inserir. UPDATE/DELETE não são concedidos. A coleta não altera decisões do robô nem faz consultas extras à exchange.

Fills retornados pelas consultas Testnet já existentes passam a gerar `TESTNET_FILL_OBSERVED`, com identidade de trade/ordem, quantidade, preço, comissão e horário informado pela exchange quando disponível. Nenhum fill antigo é inventado ou retroativamente datado. Os relatórios indicam as lacunas anteriores à implantação.

Reconciliações Production incluem todos os resumos de execução; os detalhes incluem divergências/anomalias, evitando repetir milhares de snapshots de ordens manuais idênticas. Observações manuais não são atribuídas ao CoinOps. Ausência de log HTTP histórico completo permanece explícita: configuração READ-ONLY e guardas de código não são prova de cada chamada HTTP passada.

## Auditoria e gatilhos

Checks cruzam ganhos, lucros, saldos, ledger, identidade física, Single Active Entry, posição/TP, duplicações, resets, sobreposição de ciclos, ownership, guardas Production e saúde. PASS significa evidência suficiente somente para o teste descrito. WARNING indica ausência/limite/ambiguidade ou investigação necessária. FAIL exige inconsistência comprovada. Fontes incompletas impedem conclusão global de conformidade.

O detector compara candles com janelas em que um gatilho Shadow estava armado, não com níveis apenas PLANNED. `first_cross_at` identifica o início da primeira vela com cruzamento; não é um horário exato intrabar. BUY e TP na mesma vela são AMBIGUOUS quando a sequência não pode ser determinada. Latência é relativa ao fechamento da vela. Candles Production não comprovam preço ou fill do livro Testnet.

O pacote padrão inclui candles próximos a eventos/gatilhos para controlar tamanho. Os candles completos têm download separado em páginas/stream, em partes de até 7 dias para respeitar o tempo máximo da função Vercel; a interface oferece todas as partes contíguas do período, sem truncar silenciosamente. Limites de fontes no pacote são declarados. Reduza a janela se uma fonte atingir o limite; não interprete pacote truncado como auditoria integral.

## Contrato obrigatório de evolução

### Pausa intencional de novas compras — contrato v24

O estado REAL `PAUSED` fecha entradas, não encerra a supervisão de posições:
TPs residentes antigos, fills e crédito idempotente de gain continuam sob o
reconciliador canônico. Slots, ciclo, estratégias, metas e histórico não são
reinicializados; successor/reentrada não podem liberar BUY até retomada
explícita. Nenhum export executa pausa, cancelamento, recovery ou retomada.

`LIVE_EXECUTION.csv`/JSON conservam `LIVE_PAUSED` e a observação `RECONCILED`
de proteção com `protection_verified`, `quantity_step`, `open_positions`,
`resident_buy_count`, `canceled_buy_count`, `source`, `next` e
`strategy_version`, por allowlist de escalares. Campos ausentes ficam ausentes
ou null, jamais zero inventado. Credenciais, headers e objetos livres não são
exportados nesses detalhes. Datas/identidade run/engine/shard continuam nas
colunas existentes. Não há novo CSV nem nova coleta financeira.

`PAUSED_ENTRY_PROTECTION_EVIDENCE` usa somente run/ordens/eventos persistidos do
mesmo escopo: BUY residente ou proteção explicitamente falsa é FAIL; ausência
de atestação, fonte incompleta ou ordem/fill inconclusivo é WARNING. PASS é
limitado à consistência dessa prova persistida, não comprova Binance atual,
frescor, whitelist, saúde global ou capacidade, e não habilita ocultação nem
retomada. Alertas críticos permanecem exportados e não mudam porque a conta
foi ocultada da Home. Falhas TP/ownership/stale reais voltam à Home pelo read
model canônico, não por alteração do relatório.

As preferências administrativas `account_home_preferences` e o log imutável
`account_home_preference_events` **não são coletados automaticamente neste
pacote**. Seu histórico é UI/ADMIN, não ledger financeiro. Se uma exportação
administrativa específica for necessária, ela deve autorizar o operador/conta
sob RLS e preservar apenas id, operator/account, request_id, hidden,
engine_ids, changed_by e observed_at; não deve usar o leitor financeiro genérico
(essas tabelas não possuem product/tenant/user de cada row). Não incluir
secrets ou credenciais, deduzir saúde de `hidden=true`, filtrar motores dos
relatórios por ocultação ou acoplar coleta a Watchdog/trading. Reexibir é
preferência visual; não autoriza RESUME.

### Atualização da NEXT BUY por aporte — contrato v13

`LIVE_EXECUTION.csv`/JSON conservam `NEXT_BUY_CAPITAL_REFRESH_PLANNED` e
`NEXT_BUY_CAPITAL_REFRESH_CONFIRMED` em `event_type`, com `details` contendo:
`refresh_key`, `old_client_order_id`, `new_client_order_id`, `old_quantity`,
`new_quantity`, `price`, `old_notional_quote`, `new_notional_quote`,
`slot_balance_quote`, `quote_asset`, `operation_sequence` e `capital_sources`
(IDs de allocations/items). A confirmação acrescenta `old_status`,
`old_executed_quantity`, `new_status` e `exchange_reconciled_at`.
Conta/motor/run/slot vêm do envelope de escopo existente. IDs de origem são
referências auditáveis, não cópia ou segunda contabilização do aporte.

O plano não é ACK nem prova de ordem enviada. Crash/retry entre cancelar e
confirmar mantém WARNING até haver evidência persistida completa; campos antigos
ausentes, fontes incompletas e ausência de ocorrência também são WARNING, não
zero/PASS. Divergência comprovada de preço/quantidade/ownership/execução anterior
é FAIL mesmo com outra fonte ausente. PASS limita-se ao confronto do plano e da
confirmação com as duas ordens da mesma identidade física/operação. Uma ordem
nova que preencher ou for encerrada posteriormente não reescreve a confirmação
histórica. OPEN e TP permanecem fora do escopo de redimensionamento.

A regra exportada `next_buy_applied_capital_refresh` é contrato do código atual,
sem vigência retroativa. Não há novo CSV, tabela, consulta externa ou permissão.
Testes: `next-buy-capital-refresh-audit.test.ts` e contratos do pacote v13.

### Fase 5.0 — contrato v7

O pacote v7 acrescenta o check `PRE_LIVE_AUDIT_READY`, sem criar permissão de trading. Ele separa falha ativa, recuperação histórica comprovada e falta de evidência. PASS nunca habilita LIVE. `submission_guarded_at` em `04_ORDENS.csv` representa consumo da permissão única de envio, não prova POST/ACK/fill. Eventos preservam prova quantitativa de fechamento parcial, dust e bloqueios de proteção/submissão.

A auditoria mensal aplica a política 4.2 também nas versões posteriores e reconstrói o ledger assinado no instante de cada entrada/reentrada. Estorno anterior pode reabilitar; estorno posterior não apaga violação. Cotação do reversal pertence ao ajuste original. Contas físicas somam capital manual separadamente de lucro de mercado. Preço histórico ausente não equivale a zero e permanece WARNING, sem alterar eventos ou preencher evidência inventada.

Evidências e limites completos: [Fase 5.0](./COINOPS_PRE_LIVE_AUDIT_5_0.md).

### Fase 5.1 — contrato v8

O pacote v8 acrescenta `LIVE_PREPARATION.csv` e o check `LIVE_PREPARATION_BRL_GATE`. Configurações Real BRL são lidas por escopo/RLS; filtros, preço, permissões e saldo BRL vêm de GET Binance no momento da exportação. Mínimo por slot inclui lote/notional de entrada e TP após reserva de fee; recomendado cobre a escada de 25 níveis e margem. `LIVE_PREPARATION_READY` não habilita trading. Saldo insuficiente, consulta indisponível ou dados contábeis não comprovados permanecem explícitos, nunca zero/PASS presumido. Consulte [a preparação 5.1](./COINOPS_LIVE_PREPARATION_5_1.md).

Toda nova regra operacional, estado de slot, tipo de ordem, mecanismo de execução, regime, meta, aporte, reciclagem, proteção ou comportamento que possa alterar decisões do robô deve ser incorporado à camada de auditoria/relatórios na mesma entrega, com testes correspondentes. Nova regra sem observabilidade/exportação = tarefa incompleta.

Para ampliar uma regra:

1. Persistir origem, vigência, versão e eventos necessários sem segredo.
2. Incluir a fonte/coluna explicitamente em `source-server.ts` e manter escopo/RLS.
3. Atualizar `REPORT_RULE_CONTRACT`/normalização em `report-engine.ts`, checks e detector quando aplicável.
4. Atualizar `report-package.ts`, CSV/JSON/manifest e esta documentação. Novos campos normalizados são preservados também no CSV.
5. Incluir teste que introduz a regra/estado e demonstra sua exportação e auditoria. Versionar mudança incompatível; não reinterpretar dados antigos silenciosamente.

Testes da camada ficam em `apps/web/lib/coinops-reports/*.test.ts` e integram `npm test`. Smokes da central e downloads são somente leitura; nunca clicar em execução, gain manual ou cancelamento para testar relatórios.

## Acompanhamento por ambiente e ativo

Shadow, Testnet e Real usam a mesma composição visual de resultados na Automação: seleção BTC/SOL, KPIs, slots, gráfico diário, ganhos, eventos e reconciliação. A seleção troca somente a apresentação; não inicia nem modifica execução. Cada ativo Testnet carrega seu próprio run e ledger via cliente autenticado/RLS, sem reutilizar slots ou ordens de outro ativo. Sem run, o painel informa ausência de execução. Saldos fictícios da conta permanecem distintos do capital do robô. Real exibe consultas Production e ausência de operações CoinOps enquanto LIVE estiver bloqueado. A Visão Geral compara os três ambientes sem somar capitais ou lucros entre simulação, fundos fictícios e dinheiro real.

## v15 — apresentação operacional de slots

O snapshot LIVE distingue rank da grade de rank vigente, posição visual, Mês/meta e lifetime. A ordem reutiliza estado + rank da Strategy Engine, sem escrever no ledger. Cutoff histórico ou fonte incompleta não recebe projeção atual. Ver [contrato de apresentação](./COINOPS_OPERATIONAL_SLOT_PRESENTATION.md).

## v16 — identidade e isolamento engine/shard

`ENGINE_ISOLATION.csv` e `engine_isolation` no JSON conservam operador, conta,
engine, símbolo, shard e namespace de ownership. Todos os datasets engine-scoped
incluem `executor_shard_id`; símbolo repetido não agrega ciclos de motores
diferentes. O pacote possui 27 CSVs, mantendo os anteriores.

Fonte: RPC somente leitura `coinops.read_engine_isolation_report`, com sessão
autenticada, lista de até 100 IDs por lote e autorização do operador. IDs
ausentes, repetidos ou de outro operador falham fechados. O export usa allowlist:
não inclui chave, secret, HMAC, UID Binance, credential proof bruto ou vault.

Metadados de credential PASS/IP, política `ENGINE_ISOLATION_V2`, versão declarada,
STP `EXPIRE_TAKER`, amostra de orçamento por conta, dispatches sem ACK e créditos
de proteção permanecem separados. `RECENT_SAMPLE_NOT_ADMISSION_PROOF` não é
certificação. Checks de identidade/enforcement declarados não provam runtime,
whitelist ou saúde atual; não devem ser convertidos em READY. Política ausente
em engine histórico é explicitada, não preenchida artificialmente.

O relatório não coleta orçamento Binance, habilita política, provisiona engine,
reconcilia com writes nem altera ordens. Fonte incompleta é WARNING, nunca zero
ou PASS presumido. Ver [arquitetura multi-engine](./COINOPS_MULTI_ENGINE_MULTI_SHARD.md).
