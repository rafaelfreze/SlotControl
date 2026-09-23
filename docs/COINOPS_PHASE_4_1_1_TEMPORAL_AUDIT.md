# CoinOps — auditoria temporal 4.1.1

## Conclusão

As duas ocorrências originais MISSED_LEVEL encontradas nos runs Testnet BTC/SOL são **HISTORICAL_PRE_4_1**. BTC #1 foi detectado depois da implantação, mas já havia perdido a oportunidade antes dela. SOL #1 é a ocorrência histórica da reconciliação atrasada. A Strategy Engine permanece **4.1.0**, sem mudança de decisão/adapter nesta entrega. A versão do relatório passa a 3.

Produto CoinOps; backend OnPlay Platform `otdfpmsegjxpqrzisfmi`; schema `coinops`. Escopo verificado: produto `162a3e3f-d994-4e74-90db-ae666924c77f`, tenant `371dbf6e-2ce4-4bfe-9e15-3a25f2905607`. Somente metadados aditivos de auditoria; nenhum slot, saldo, gain, ordem ou histórico original é alterado. Binance Production READ-ONLY; LIVE bloqueado; Testnet usa fundos fictícios.

## Marco exato da versão

| Evidência | UTC |
| --- | --- |
| Deploy 4.1 READY | 2026-09-23 14:31:34.826 |
| Primeiro RECONCILIATION_STARTED com SHA 4.1 — BTC | **2026-09-23 14:32:20.558** |
| Primeiro início SOL | 2026-09-23 14:32:20.567 |
| Primeira decisão persistida 4.1 — CREATE_TP BTC | 2026-09-23 14:32:23.235989 |
| Primeira reconciliação bem-sucedida SOL/BTC | 14:32:23.579256 / 14:32:26.716628 |

`STRATEGY_4_1_EFFECTIVE_AT = 2026-09-23T14:32:20.558Z`.
Deploy `dpl_B8qB5GnqYkjtT4iFRTomUNkm5mau`; SHA `7530824fa194fe2faf9bc87d87fa5b7c02647bf0`. READY prova disponibilidade; o evento com esse SHA prova processamento efetivo. Evento inicial BTC `36b625bf-b1f7-4f96-ac36-7e39af2d6825`.

## Inventário original completo observado

Consulta dos três runs BTC/SOL: duas ocorrências originais e dois diagnósticos anteriores. Diagnósticos não são novas ocorrências. Os relatórios atuais consultam novamente as fontes; esta evidência é um snapshot, não promessa de ausência futura.

| Campo | BTC #1 | SOL #1 |
| --- | --- | --- |
| cycle_id/run_id | `97ec29bb-8673-4fbf-8b8d-6cb326a64572` | `818b4b13-807d-4c7c-9ef1-7e34ecdca715` |
| Evento original | `4226bc6b-42f8-45d9-9e61-4dc51e6e026e` | `44453626-67c8-46c7-8def-c543595e726a` |
| event_type / event_key | MISSED_LEVEL_DURING_REARM / SLOT_1_MISSED_2 | MISSED_LEVEL_DURING_REARM / SLOT_1_MISSED_2 |
| Reentrada / operação | 85.480,48 / sequência 2 | 118,97 / sequência 2 |
| occurred_at — início da janela causal, TP | 2026-09-23T14:01:50.234Z | 2026-09-23T04:23:36.439Z |
| occurred_by_at — cruzamento já ocorreu até | 2026-09-23T14:13:24.677Z | 2026-09-23T07:44:48.036Z |
| first_cross_at exato | null — não persistido | null — não persistido |
| detected_at | 2026-09-23T14:32:24.651Z | 2026-09-23T12:30:07.235025Z |
| Evento observed_at | 2026-09-23T14:32:24.662368Z | 2026-09-23T12:30:07.235025Z |
| created_at original | null — coluna ausente | null — coluna ausente |
| strategy_version no fato | null — legado pré-4.1 não persistido | null — legado pré-4.1 não persistido |
| Versão da detecção | 4.1.0 | null |
| root_cause | STALE_CACHED_RUN_DISCOVERY | STALE_CACHED_RUN_DISCOVERY |
| resolved_by_version | 4.1.0 | 4.1.0 |
| resolved_at — primeira reconciliação corrigida | 2026-09-23T14:32:26.716628Z | 2026-09-23T14:32:23.579256Z |
| Classificação | HISTORICAL_PRE_4_1 | HISTORICAL_PRE_4_1 |

`occurred_at_basis = TP_FILL_UNRECONCILED_WINDOW_START`: o TP inicia a janela de reentrada sem reconciliação, **não é o instante exato do cruzamento**. A classificação usa também o fill independente do nível inferior antes do marco. `resolved_at` é evidência derivada de correção da causa, não horário de recuperação da oportunidade financeira. Não houve compra retroativa.

BTC possui operação de recuperação `8655a9523eec67e2cb730f7dbf9c9ad8906073d6149bd783e845d89094cab477`, decisão PLAN_LOCAL_REENTRY vinculada por ciclo/slot/sequência/alvo/tempo. O `decision_id` do evento MISSED antigo apontava para armar outro slot e não é reutilizado como identidade da reentrada. SOL não possuía operation_id legado persistido: permanece null, com sequência 2 preservada.

## Linha do tempo BTC

1. BUY #1 preenchida 12:50:00.068Z: preço 85.480,48, quantidade 0,00011; trade 103002.
2. TP #1 preenchido na Testnet 14:01:50.234Z: preço 85.907,89, trade 103512, ordem 2536249.
3. BUY #2 preenchida 14:13:24.677Z: preço 84.625,67, inferior à reentrada #1; trade 103568, ordem 2536250. Logo o mercado já cruzara o alvo no intervalo `(14:01:50.234, 14:13:24.677]`, antes do READY e do processamento 4.1.
4. TP só coletado 14:32:22.202Z: **30m31,968s** após o fill.
5. PLAN_LOCAL_REENTRY #1 criado 14:32:24.243823Z; mercado observado 84.024,80, já abaixo de 85.480,48. Nenhuma BUY residente #1 sequência 2 foi criada ou cancelada/substituída. Evento MISSED preserva a oportunidade perdida, sem MARKET retroativo.
6. `missed_at` do snapshot é 14:32:24.618Z; detecção/evento têm milissegundos distintos. Nenhum desses horários redefine o fato anterior.

Fontes: TP `13cdc983-ef4a-45be-aa13-c7cf4f97ba62`, BUY inferior `3d4f6f5e-ef8e-4bf3-8999-0eec7ff566d7`, reconciliação corrigida `e1547f99-feda-4741-bcc8-a7af6e6d6eb4`. Fills têm exchange_time e ownership CoinOps conferidos. **O missed BTC apenas foi registrado/exibido depois da 4.1.0; não é uma nova regressão 4.1.**

## SOL #1 e prova de reentrada SOL #5

SOL #1: TP 04:23:36.439Z, preço 119,59, trade 33521, ordem 667682. BUY #2 07:44:48.036Z, preço 117,78 < 118,97, trade 33850. TP coletado 12:30:04.982Z: **8h06m28,543s** de atraso. Fontes TP `4c888121-6af0-482c-9d35-9c6f5ce6a8a6`, BUY inferior `b83548c0-d0dc-406f-bbf6-cfedb344f8cd`, reconciliação corrigida `c8992a29-89f2-4b59-aa43-149edd08edef`.

SOL #5 pós-4.1:

- TP na exchange 14:54:37.253Z, preço 114,86, trade 35407.
- Coleta 14:55:23.111Z: 45,858 segundos após o fill.
- PLAN_LOCAL_REENTRY 14:55:23.672844Z, sequência 2, saldo lógico 10,05046; outras três posições OPEN.
- CANCEL_REPLACE_NEXT_BUY 14:55:24.108722Z; BUY inferior #6 cancelada/substituída 14:55:24.773713Z.
- BUY #5 residente 14:55:25.530Z: alvo 114,28, quantidade 0,087, ordem 697438. TP → BUY residente: **48,277 segundos**.
- Operação `faf3102c8050392e51a801d47eae09c27536236185b6d87915b348c4a7f4984d`; estado observado ARMED/REENTRY, sem missed.

Isso comprova uma reentrada pós-correção, não uma garantia de latência futura. Worker é polling serverless de 60s com watchdog 300s, não stream contínuo.

## Estado operacional e auditoria aditiva

BTC #1 e SOL #1 persistem MISSED/REENTRY sem ordem. A apresentação deriva **REENTRY WAITING — aguarda ciclo futuro**, preservando o estado bruto no detalhe. Não rearma, não compra e não altera gain/saldo. Qualquer OPEN/ARMED/PLANNED real atual prevalece sobre histórico antigo.

Contagem exclusiva por slot físico: OPEN + NEXT BUY + REENTRY WAITING + PLANNED + ACTIVE ERROR = 25. Ocorrências históricas ficam fora dessa soma. Saúde verde exige histórico resolvido, checkpoint fresco e invariantes atuais válidos; amarelo para incerteza/latência; vermelho para regressão ativa/invariante comprovado. Histórico não mascara problemas novos.

Snapshot remoto de 23/09/2026 15:35:02 UTC: BTC ACTIVE, 1 OPEN + 1 NEXT BUY + 1 REENTRY WAITING + 22 PLANNED; SOL ACTIVE, 3 OPEN + 1 NEXT BUY + 1 REENTRY WAITING + 20 PLANNED. Ambos 25 slots, uma BUY residente, TP para cada posição aberta, `last_error=null`; checkpoints 15:34:22.902/15:34:23.557 UTC. Dois históricos originais; nenhuma nova ocorrência identificada. A projeção REENTRY WAITING é de leitura: banco ainda registra MISSED em #1.

A migration `20260923153046_classify_pre_4_1_testnet_missed_levels.sql` foi aplicada no backend oficial e acrescentou exatamente dois MISSED_LEVEL_DIAGNOSED, com chave derivada do evento original e ON CONFLICT. Valida escopo, fills/ordens próprios, preços, cronologia, SHA do primeiro processamento e reconciliação 4.1 antes de inserir. Usa lock transacional; falha fechada se a evidência divergir. Não modifica tabela/ordem financeira e pode ser reaplicada sem duplicação. Idempotência revisada estaticamente; nenhuma reaplicação remota de teste. Não se executa teste financeiro no banco vinculado. O nome local foi alinhado à versão registrada pelo serviço de migrations.

## Validação e publicação

Testes cobrem limites temporais, insert posterior com fato anterior, classificação causal, vínculo/deduplicação, histórico versus estado atual, saúde, invariantes, CSV/JSON e janela desde a versão. O fechamento registra resultados de execução, migration remota, SHA/deploy e smoke efetivamente observados. Testes de unidade não equivalem a prova de navegador ou a garantia contínua da exchange.

Validação local do bloco: 324 testes aprovados (`npm test`), lint sem avisos/erros, typecheck aprovado e build Next.js 14.2.35 concluído. Guardas Production GET-only e criação/cancelamento LIVE bloqueados permanecem cobertos. O smoke publicado é reportado no fechamento da tarefa; não é inferido do build.

Publicação principal: commit `4418cd4`, GitHub/main, deployment `dpl_G5k5nwnr3oA34JvhSVdF33KqgSuc` READY no domínio oficial. Smoke autenticado de Automação/Relatórios em desktop 1920×919 e mobile 390×844: históricos BTC/SOL separados, #1 em espera com ledger MISSED preservado, SOL #5 reentrada armada, contadores de 25 slots, marco exato e relatório v3. Documento móvel medido sem overflow horizontal (scrollWidth=innerWidth=390). Janela Testnet desde a estratégia retornou 58 checks conformes, seis avisos de limites de evidência, zero divergências, dois históricos, zero missed novo/ativo e um gain pelo TP versus dois créditos observados. Não confundir créditos tardios com ganhos produzidos pela versão.

O smoke identificou um defeito anterior a esta fase (`0798dcd` já o continha): o resumo visual somava apenas slots atualmente CLOSED e omitia gains/lucros de slots já reciclados. A correção complementar é somente de leitura: somar acumulados persistidos por ciclo/slot, sem filtrar pelo estado atual; apresentar a lista como resultados acumulados, não como operações individuais reconstruídas. Nenhum saldo/ledger/engine é modificado por essa correção.

Após o ajuste complementar: 327 testes aprovados, lint/typecheck direcionados e novo build aprovados. Não houve segunda migration; uma publicação adicional foi necessária pela falha visual descoberta no smoke.
