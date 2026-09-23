# CoinOps — relatórios auditáveis, versão 1

Central: `/relatorios`. Legado de relatórios oficiais de ciclos: `/plano-crescimento/relatorios` (preservado, não misturado ao robô V1).

## Escopo e segurança

Produto CoinOps, Supabase `otdfpmsegjxpqrzisfmi`, schema `coinops`. A rota `/api/coinops-reports` autentica com `auth.getUser()`, resolve produto/tenant/usuário no servidor pela configuração CoinOps e pela estratégia visível sob RLS. Cada página de cada consulta filtra os três identificadores; uma linha de outro escopo aborta a exportação. O cliente não escolhe tenant nem usuário. A rota não usa service role, credenciais Binance ou serviços de execução.

Downloads são respostas privadas `no-store`, sem URL pública persistente ou arquivo bruto armazenado. O histórico da interface guarda somente os metadados dos downloads da sessão, sem valores financeiros. Não há duplicação do ledger nem das operações. Não há nova permissão para executar ordens. Production Binance continua READ-ONLY e LIVE bloqueado.

## Pacote e formatos

`coinops-report-AAAA-MM-DD_AAAA-MM-DD.zip` contém 15 CSVs numerados, `AUDITORIA_COMPLETA.json`, `manifest.json` e `RESUMO.md`. Também há download individual e exportação separada de candles 1m completos.

CSVs têm BOM UTF-8, separador `;`, CRLF, campos escapados entre aspas, ponto decimal e proteção contra fórmula em células textuais. No Excel brasileiro, importar como UTF-8, delimitador `;`, e usar localidade Inglês (Estados Unidos) para números. Datas ISO. Persistência UTC; datas de filtro são dias inclusivos de `America/Campo_Grande`, transformados em intervalo UTC com fim exclusivo. Janela máxima: 366 dias. Campos sem evidência são vazios/null, não zero.

O ZIP usa DEFLATE/CRC32 e nomes fixos sem caminhos. O manifest informa SHA-256 e bytes de cada arquivo de conteúdo; não calcula hash de si próprio. Mesmo snapshot, filtros e versão produzem JSON/ZIP determinísticos. `generated_at` e dados novos mudam naturalmente o conteúdo entre gerações. `app_commit_sha` vem de `VERCEL_GIT_COMMIT_SHA`, quando disponível.

## Fontes e interpretação

- Shadow: configs, ciclos, slots, operações arquivadas, contas físicas, créditos imutáveis, eventos e candles do robô V1.
- Testnet: runs, slots, ordens e eventos, sempre marcados como **BINANCE TESTNET / FUNDOS FICTÍCIOS**. Ownership compara clientOrderId com a identidade determinística do run/slot/lado/revisão. IDs observados externamente não são suficientes para atribuir ownership.
- Real: conexão e reconciliações Production, intents com modo explicitado, regras e checklist de preparação. Ordens/trades manuais observados pela reconciliação não viram operações CoinOps. Nenhuma ordem real é criada pelo relatório.
- Créditos de compounding são ligados à operação por `operation_id`. A data econômica vem de `closed_at`, não de um `credited_at` de backfill. Preserva-se também a data da persistência.
- `physical_slot_number` identifica o slot físico; `logical_level` e `operation_sequence` identificam sua posição/reutilização. Ciclos incluem motivo de conclusão/reset e vínculo ao próximo ciclo quando persistido.

Snapshots atuais de slots/configuração/ordens não devem ser lidos como estado de uma data passada. Valores históricos só são reconstruídos com operações/créditos/eventos suficientes. Exportação por páginas não é snapshot transacional único: os instantes e a base da evidência são explícitos. Falha ou limite em uma fonte gera `incomplete_sources` e WARNING; não esconde registros nem certifica completude.

## Evidência adicionada nesta versão

A migration aditiva `20260923004502_add_report_runtime_observations.sql` cria observações de execução do motor e dos diagnósticos Testnet já existentes. Registra somente metadados permitidos, com identidade de escopo, versão e idempotência. RLS é obrigatória; usuários autenticados podem ler seu escopo, e somente o serviço pode inserir. UPDATE/DELETE não são concedidos. A coleta não altera decisões do robô nem faz consultas extras à exchange.

Fills retornados pelas consultas Testnet já existentes passam a gerar `TESTNET_FILL_OBSERVED`, com identidade de trade/ordem, quantidade, preço, comissão e horário informado pela exchange quando disponível. Nenhum fill antigo é inventado ou retroativamente datado. Os relatórios indicam as lacunas anteriores à implantação.

Reconciliações Production incluem todos os resumos de execução; os detalhes incluem divergências/anomalias, evitando repetir milhares de snapshots de ordens manuais idênticas. Observações manuais não são atribuídas ao CoinOps. Ausência de log HTTP histórico completo permanece explícita: configuração READ-ONLY e guardas de código não são prova de cada chamada HTTP passada.

## Auditoria e gatilhos

Checks cruzam ganhos, lucros, saldos, ledger, identidade física, Single Active Entry, posição/TP, duplicações, resets, sobreposição de ciclos, ownership, guardas Production e saúde. PASS significa evidência suficiente somente para o teste descrito. WARNING indica ausência/limite/ambiguidade ou investigação necessária. FAIL exige inconsistência comprovada. Fontes incompletas impedem conclusão global de conformidade.

O detector compara candles com janelas em que um gatilho Shadow estava armado, não com níveis apenas PLANNED. `first_cross_at` identifica o início da primeira vela com cruzamento; não é um horário exato intrabar. BUY e TP na mesma vela são AMBIGUOUS quando a sequência não pode ser determinada. Latência é relativa ao fechamento da vela. Candles Production não comprovam preço ou fill do livro Testnet.

O pacote padrão inclui candles próximos a eventos/gatilhos para controlar tamanho. Os candles completos têm download separado em páginas/stream, em partes de até 7 dias para respeitar o tempo máximo da função Vercel; a interface oferece todas as partes contíguas do período, sem truncar silenciosamente. Limites de fontes no pacote são declarados. Reduza a janela se uma fonte atingir o limite; não interprete pacote truncado como auditoria integral.

## Contrato obrigatório de evolução

Toda nova regra operacional, estado de slot, tipo de ordem, mecanismo de execução, regime, meta, aporte, reciclagem, proteção ou comportamento que possa alterar decisões do robô deve ser incorporado à camada de auditoria/relatórios na mesma entrega, com testes correspondentes. Nova regra sem observabilidade/exportação = tarefa incompleta.

Para ampliar uma regra:

1. Persistir origem, vigência, versão e eventos necessários sem segredo.
2. Incluir a fonte/coluna explicitamente em `source-server.ts` e manter escopo/RLS.
3. Atualizar `REPORT_RULE_CONTRACT`/normalização em `report-engine.ts`, checks e detector quando aplicável.
4. Atualizar `report-package.ts`, CSV/JSON/manifest e esta documentação. Novos campos normalizados são preservados também no CSV.
5. Incluir teste que introduz a regra/estado e demonstra sua exportação e auditoria. Versionar mudança incompatível; não reinterpretar dados antigos silenciosamente.

Testes da camada ficam em `apps/web/lib/coinops-reports/*.test.ts` e integram `npm test`. Smokes da central e downloads são somente leitura; nunca clicar em execução, gain manual ou cancelamento para testar relatórios.
