# CoinOps — auditoria adversarial pré-LIVE 5.0

## Identidade, escopo e baseline

- Executor: Codex Desktop Local, checkout `F:\Projetos\SlotControl`.
- Origin: `https://github.com/rafaelfreze/SlotControl.git`; branch oficial `main`.
- Baseline auditado e publicado: `3b967b7d974af46ef715b6369f8d97168cc74ae5`, main/origin/main alinhadas, árvore inicialmente limpa. Vercel Production READY `dpl_9P4jxevNNhv6MFgc6hMEVvCnb7Tj`.
- Produto CoinOps; backend OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`; único escopo CoinOps existente confirmado por consultas de leitura. Outros schemas não foram alterados.
- Vercel: projeto `cripto`, `prj_GNCqXG8MVG2ePgU3y6vuosz06GoR`, root `apps/web`, domínio `https://cripto-flax.vercel.app`.
- Strategy Engine corrigida `4.3.1`; relatório v7. Não há habilitação de LIVE nem nova regra de negócio.
- [Snapshot pré-auditoria](./COINOPS_PRE_LIVE_SNAPSHOT_5_0.md): 100 estados físicos atuais, ranks, contadores, saldos, configurações, ordens e saúde às 22:41 UTC de 23/09/2026.

## Gate e publicação

O runtime exporta `PRE_LIVE_AUDIT_READY` como um check de evidência, não feature flag. Falha ativa de ledger, ordem, meta, rank, recovery ou segurança exige FAIL; falta de evidência/histórico recuperado exige WARNING. Mesmo PASS não autoriza execução real. **Conclusão da auditoria: WARNING**, pelos históricos recuperados e limites de evidência descritos abaixo; nenhuma divergência operacional ativa identificada no snapshot dos quatro motores. A confirmação do gate online e do SHA final é informada na entrega, após a publicação deste bloco. Resultados sintéticos não substituem a medição online.

## Findings e provas

As reproduções e severidades estão divididas para manter rastreabilidade:

- [Motor único e ATH](./COINOPS_PRE_LIVE_STRATEGY_5_0.md): 8 findings, snapshots property, rollover, Top15/Reserve, prioridade de preço e replay longo.
- [Execução e recovery](./COINOPS_PRE_LIVE_EXECUTION_5_0.md): partials, filtros, leases, ACK perdido, initial e single entry.
- [Ledger financeiro](./COINOPS_PRE_LIVE_LEDGER_5_0.md): FX NULL/NaN, crédito atômico, ajustes, estornos, RLS e prova PostgreSQL real isolada.
- [Fechamento parcial SQL](./COINOPS_PRE_LIVE_PARTIAL_SQL_5_0.md): prova quantitativa compartilhada, reset, gains mensais e idempotência.
- [Revisão independente dos relatórios](./COINOPS_PRE_LIVE_REPORT_REVIEW_5_0.md): lifetime assinado, paridade dos 25 slots, fontes incompletas e cobertura obrigatória do gate.

Findings adicionais da camada de auditoria/configuração:

| ID | Severidade | Causa e correção |
|---|---|---|
| AUD-01 | MEDIUM | Adoção mensal reconhecia somente versão literal 4.2. Agora 4.3/patches posteriores conservam a política, sem retroagir ao período pré-4.2. |
| AUD-02 | MEDIUM | Primeiro cruzamento de meta era usado sem considerar reversal. Ledger assinado é reconstruído no instante da decisão; timestamps indistinguíveis permanecem WARNING. |
| AUD-03 | MEDIUM | FX de reversal era comparado à data do estorno. A referência correta é a criação original, com tolerâncias de frescor iguais ao contrato SQL. |
| AUD-04 | MEDIUM | Conta Shadow ignorava capital/gains manuais ao confrontar saldo e contagem. Ambos entram separados do P&L de mercado e vinculados à mesma identidade física. |
| AUD-05 | MEDIUM | Checks de reentrada não distinguiam ausência de preços nem recuperação histórica comprovada. Ausência é WARNING. No smoke, a leitura completa de previous_state comprovou desvio histórico real de um tick no BTC slot #5, reparado às 17:50 UTC; não era ausência de preço. O evento divergente permanece FAIL histórico, com recuperação causal separada no gate. |
| CFG-01 | MEDIUM | Server action gravava perfil e evento ATH em requests separados. Trigger transacional agora salva ambos ou nenhum; versão não pode ser reutilizada com payload diferente. Backend/ref também verificado antes da ação. |
| SIM-01 | MEDIUM, evidência | A sequência artificial gerada pela UI cruzava preços teóricos, não normalizados ao tick, e executava 24 dos 25 níveis. Gerador e escada agora compartilham a fórmula pura de preço; regressão prova 25 BUY, PRIMARY 11→25 seguido de RESERVE 10→1, sem mudar regras de execução. |

## Contabilidade e interações

Fórmula preservada: capital inicial + aportes + gains manuais financeiros + P&L líquido realizado − reversals. P&L aberto não entra como lucro realizado. Aporte não incrementa gain; gain manual afeta meta/rank, mas não performance de mercado.

Prova SQL OPEN: posição de 100 recebe +5, conserva BUY/quantidade/entry/TP, fecha com +2 líquido e disponibiliza 107 para próxima operação. Crédito, estado CLOSED, evento e gain mensal são uma transação. Replays não duplicam. Crash legado com evento antes do PATCH é reconciliado sem perder ajuste intermediário. Shadow já usava crédito transacional por operação.

Reversals são linhas imutáveis, preservam FX original e período da origem. Não apagam histórico nem deslocam um ganho do mês anterior para o atual. Partial BUY, parcial TP, taxas de base/quote e dust são avaliados por quantidades executadas, nunca por principal reservado.

Snapshot de leitura às 22:58 UTC: Shadow BTC `250 + 0,2830916 = 250,2830916`, 6 gains; SOL `250 + 0,74403 = 250,74403`, 15 gains; nenhuma diferença nos 50 saldos. Testnet BTC `250,1391731`, SOL `250,25192`, nenhum clientOrderId duplicado, nenhum ajuste manual real persistido. Valores são fictícios/operacionais e mudam com os motores ativos.

## Segurança e isolamento

- Production continua adapter GET-only; create/cancel bloqueados por contrato e testes de transporte. LIVE não é modo executável V1; símbolos de execução V1 continuam BTCUSDC/SOLUSDC.
- Configuração REAL é preparação: percentuais BTC 1,2%/1% e SOL 5,5%/1,5% são aceitos nos testes puros/SQL, isolados dos quatro motores. Nenhum símbolo BRL foi liberado para execução nem capital mínimo recalculado.
- RLS/FORCE RLS e grants das tabelas 4.2–4.4 foram inspecionados no banco oficial. authenticated tem SELECT; mutations e RPCs privilegiados somente service_role; SECURITY DEFINER com search_path vazio. View de totais usa security_invoker.
- Helper oficial exige identidade, membership ativo, role CoinOps, tenant/product ativos, com exceção explícita de administrador de plataforma já existente. Nenhuma policy compartilhada foi modificada.
- Exercícios SQL de outro tenant/usuário, acesso anônimo, EXECUTE e ledger imutável ocorrem apenas em banco local isolado. O conector remoto não permite `SET ROLE authenticated`; não se declara impersonação remota validada.
- HTTP publicado sem sessão: `/api/coinops-reports?format=preview` retornou 401 `COINOPS_REPORT_AUTH_REQUIRED`. Export não chama execução nem exchange.

## Migrations

Todas versionadas, CoinOps-only, sem apagar histórico ou alterar saldos existentes:

1. `20260923231728_harden_robot_v1_manual_adjustments.sql` — guards financeiros/FX e liquidação atômica Testnet.
2. `20260923231731_harden_robot_v1_testnet_partial_accounting.sql` — prova compartilhada de fechamento, monthly e reset; aceita EXPIRED_IN_MATCH.
3. `20260923231734_guard_testnet_order_submission.sql` — permissão única de envio durável. Timestamp não é ACK.
4. `20260923231736_make_robot_v1_ath_config_audit_atomic.sql` — evento de configuração e perfil na mesma transação.

Aplicadas pelo conector oficial entre 23:17:28 e 23:17:36 UTC de 23/09/2026; quatro retornos success e histórico remoto conferido. Nomes locais alinhados aos timestamps atribuídos pelo Supabase. Preflight: zero ajustes manuais, zero PREPARED, zero valores não finitos, seis perfis e nenhum perfil pendente.

Compatibilidade de rollout: caminho FILLED legado continua reconhecido; parcial exige prova nova. Inserts de workers antigos recebem guard conservador; o novo runtime explicita NULL somente na preparação inédita. Novas funções só serão chamadas pelo código publicado após migrations. Código antigo não deve ser considerado corrigido antes do deploy. Não há DROP de tabela, TRUNCATE, exclusão de operação ou mudança de credencial.

## Validação consolidada local

- Suíte completa inicial: 491/491 PASS. Após as regressões do smoke: **505/505 PASS, zero SKIP**. Inclui 49 casos PostgreSQL reais (29 ledger, 16 partial/restart, quatro configuração ATH), com clusters efêmeros locais e rollback. Nenhum teste financeiro usou o Supabase vinculado.
- Lint, typecheck e build Next.js 14.2.35: PASS. Renomeação posterior das migrations apenas alinha metadados/caminhos, sem modificar SQL ou runtime.
- 6.000 snapshots property, 4.000 candles determinísticos, 36 fronteiras mensais e 4.500 chamadas SQL com seed reproduzível: detalhes nas subauditorias.
- Scan dirigido de 38 arquivos client e 40 bundles JavaScript: zero referências diretas aos nomes de secrets verificados e zero padrões comuns encontrados. É evidência dirigida, não prova absoluta de inexistência de qualquer secret arbitrário.
- Aviso Node `MODULE_TYPELESS_PACKAGE_JSON` preexistente, sem falha funcional; não foi alterada incidentalmente a configuração de módulos.

## Limites explícitos

- Crash entre consumir permissão e POST pode ficar `SUBMISSION_OUTCOME_UNKNOWN`. Recovery é GET-only; não se reenvia cegamente quando não é possível distinguir ordem perdida de ordem inexistente.
- Partial inferior aos filtros oficiais não recebe TP inválido. Bloqueia novas entradas e sinaliza risco até a posição ser protegível; dust permanece explícito.
- Testes injetam crashes/transações e transportes; não encerram Vercel real nem forçam indisponibilidade Binance.
- Replay longo de 4.000 candles e property de 6.000 snapshots não substituem as 4.500 chamadas SQL de ajustes/reversal; evidências complementares, não uma alegação de simulação monolítica de todas as falhas.
- Não há histórico HTTP externo completo, websocket contínuo comprovado, nem promessa de latência máxima. Cotação ticker informa coleta, não timestamp de último trade.
- Testes SQL requerem PostgreSQL Windows local; sem binários, SKIP explícito. Nesta auditoria os bancos locais foram executados, não apontados ao Supabase vinculado.

Production READ-ONLY. LIVE bloqueado. Zero operação financeira real.

## Evidência de publicação e smoke

O bloco de execução foi publicado em `e83b8fac233fd9272e76f1ccf693e3bad6e86ce0`, deployment `dpl_3iECAJW8T1FRVSk82UZBpyFwhHLF` READY, associado ao domínio canônico. A observação Testnet da própria aplicação às 23:24 UTC registra esse SHA e consultas concluídas diretamente na Binance Testnet: BTC duas ordens abertas, SOL quatro, todas de ownership CoinOps; saldos fictícios reconciliados. Não foi criada ordem para testar a interface.

Às 23:26 UTC, todos os quatro motores já haviam adotado Strategy Engine `4.3.1`, sem erro ativo, com perfis preservados em 0,5%/1%, 25 slots por ativo/ambiente e regime NORMAL. O cron Shadow executou às 23:25 e a reconciliação Testnet às 23:26.

| Motor | OPEN | NEXT BUY | Demais estados | Saldo lógico USDC |
|---|---:|---:|---|---:|
| Shadow BTC | 4 | 1 | 20 PLANNED | 250,2830916 |
| Shadow SOL | 4 | 1 | 19 PLANNED + 1 CLOSED/META | 250,74403 |
| Testnet BTC | 1 | 1 | 22 PLANNED + 1 reentrada histórica em espera | 250,1391731 |
| Testnet SOL | 3 | 1 | 19 PLANNED + 2 reentradas em espera/meta | 250,25192 |

Smoke Chrome autenticado: desktop 1920px; mobile 390px com lista completa de 25 slots, detalhes progressivos, meta/rank, TP e sequência de operação; configuração/preparação REAL a 320px sem overflow horizontal. Formulários de gain/aporte inspecionados sem preview/confirmar, salvar perfil ou registrar movimento. Simulador contábil publicado A–J: 10/10, incluindo OPEN100+5+2=107.

O primeiro smoke identificou dois problemas de evidência, corrigidos neste bloco: o gate ainda tratava o tick histórico reparado como ativo; ordens já CANCELED apareciam NEW no corte do relatório por precedência incorreta de evento antigo sobre snapshot. O saldo persistido não divergia. A reconstrução agora respeita o corte temporal e informa origem/data do estado em JSON/CSV. Também foi corrigida a sequência artificial do simulador para cruzar os preços já normalizados ao tick e atingir todos os 25 níveis.

As três divergências históricas continuam exportadas: dois checks para o mesmo desvio de tick Shadow BTC, com reparo causal comprovado e preço atual restaurado; uma decisão SOL Testnet sem despacho original, posteriormente recuperada por pós-condição. Não são apagadas nem reescritas como PASS. O gate separa essas recuperações, exige os checks críticos dos quatro motores e permanece FAIL diante de qualquer perda de saldo, nova divergência de preço ou outra falha ativa. Os testes negativos incluem provas de reparo falsificadas/incompatíveis e perda de capital que não pode ser exonerada por reparo de preço.

Logs Vercel do primeiro deployment: nenhum error/fatal encontrado no recorte consultado. Chrome emitiu uma mensagem isolada “Receiving end does not exist”; não houve erro correspondente na aplicação ou falha no fluxo observado. A navegação direta ao endpoint diagnóstico foi bloqueada pelo cliente do navegador; a verificação Testnet utilizou a página autenticada oficial e sua evidência server-side persistida, sem contornar o bloqueio.
