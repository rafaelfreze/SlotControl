# CoinOps — relatórios auditáveis (runbook histórico)

O contrato efetivo em `apps/web/lib/coinops-reports/filters.ts` é agora
`report_version = 11`. O texto abaixo documenta a evolução histórica da versão 3;
afirmações antigas de LIVE bloqueado não descrevem a operação atual.
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

Downloads são respostas privadas `no-store`, sem URL pública persistente ou arquivo bruto armazenado. O histórico da interface guarda somente os metadados dos downloads da sessão, sem valores financeiros. Não há duplicação do ledger nem das operações. Não há nova permissão para executar ordens. Production Binance continua READ-ONLY e LIVE bloqueado.

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
