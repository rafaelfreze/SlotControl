# CoinOps 5.6 — operador privado, múltiplas contas e mercados

## Estado deste documento

Runbook da implementação local da Fase 5.6, preparado em 24/09/2026. Descreve contratos presentes no código e nas migrations versionadas; **não comprova aplicação remota, publicação ou READY**. O fechamento deverá acrescentar SHA, deployments, evidências antes/depois e resultados finais à seção de gates.

- Código oficial: `rafaelfreze/SlotControl`, `main`; aplicação em `apps/web`.
- Backend: OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`.
- Vercel: projeto `cripto`, domínio canônico `https://cripto-flax.vercel.app`.
- Executor existente: IPv4 `46.101.104.48`.
- Somente Rafael permanece autorizado em Production, exclusivamente BTCBRL/SOLBRL. Nenhuma conta de amigo ou novo mercado Production é criado/ativado como teste desta fase.
- A fase altera identidade e isolamento, não estratégia financeira, saldos ou autorização de exposição. Não autoriza saque, transferência, margem, Futures ou uso do saldo excedente.

## Baseline financeiro que deve ser preservado

| Motor Rafael | Slots | Hard cap nativo | Gain | Spacing normal | Spacing pós-ATH | Meta mensal por slot |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| REAL BTCBRL | 25 | 450 BRL | 1,2% | 1% | 5% | 7 |
| REAL SOLBRL | 25 | 275 BRL | 5,5% | 1,5% | 8% | 2 |

O cap da conta em BRL permanece 725. O executor legado preserva caps de ordem de 18 BRL BTC e 11 BRL SOL. Saldo livre adicional da Binance não aumenta estes limites.

Os perfis rápidos Shadow/Testnet existentes continuam com gain 0,5% e spacing 1%, sem reinício provocado pela migration. A Strategy Engine compartilhada continua versão `4.3.1`; não existe uma segunda estratégia para novas contas.

### ATH: preservação explícita da referência legada

`trading_engines.ath_reference_symbol` distingue o mercado operado da fonte histórica de ATH. Os motores legados preservam BTCUSDC/SOLUSDC como referência, inclusive os LIVE em BRL. Trocar essa referência silenciosamente converteria a unidade do comparativo e poderia produzir transição falsa de regime. Novos motores usam seu próprio símbolo como referência por padrão. Nesta fase não converter nem reiniciar ATH, floor, Top15/Reserve ou os estados históricos existentes.

## Modelo e identidades

```text
operator (usuário CoinOps autenticado, produto e tenant)
└─ exchange_account (UUID imutável; nome apenas de apresentação)
   ├─ account_quote_caps (um cap por moeda da conta)
   └─ trading_engine (UUID; conta + ambiente + símbolo únicos)
      └─ perfil → ciclo/run → 25 slots → decisões → ordens/fills/ledger
```

| Entidade | Contrato |
| --- | --- |
| `operators` | Vínculo com produto/tenant/usuário, status e kill switch global do operador. Não cria novos logins. |
| `exchange_accounts` | UUID, operador, `display_name`, status, `credential_ref`, `executor_profile`, kill switch e designação legada explícita. |
| `trading_engines` | Conta, ambiente REAL/SHADOW/TESTNET, símbolo, base/quote, referência ATH, config, hard cap nativo, status e kill switch. |
| `account_quote_caps` | Limite por conta + moeda; moedas diferentes não entram no mesmo enforcement. |
| `operator_admin_events` | Eventos administrativos append-only, antes/depois sanitizados e identidade de conta/motor. |
| `account_onboarding_checks` | Evidência append-only por conta/motor/check, PENDING/PASS/FAIL, ator e chave idempotente. |

As tabelas operacionais recebem `operator_id`, `exchange_account_id`, `trading_engine_id` e `quote_asset`. FKs compostas, triggers de identidade e índices impedem associar filho de uma conta a pai de outra. Chaves físicas de slots, UUIDs de runs e ordens, histórico e IDs da exchange já existentes não são regenerados no backfill.

Os conceitos `is_legacy_default` da conta e `legacy_compatible` do motor são explícitos. Um caller sem IDs só pode resolver o mapeamento legado inequívoco. IDs parciais, inexistentes, cruzados ou conflitantes não acionam fallback.

### Fontes principais no código

- `apps/web/lib/execution/operator-context.ts` e `operator-context-server.ts`: validação de registry e resolução de contexto autenticado.
- `apps/web/lib/execution/robot-v1-{live,shadow,testnet}-server.ts`: runtimes por motor; reaproveitam a mesma Strategy Engine.
- `apps/web/lib/execution/live-executor-{transport,health,client}.ts`: envelopes assinados e verificação das respostas do executor.
- `apps/live-executor/src/account-registry.mjs`: registry confiável, credencial, ownership e continuidade de claims.
- `apps/web/app/automacao/operator-presentation-server.ts` e `premium-operator.ts`: dados e agregações de apresentação por conta/motor/moeda.
- `apps/web/lib/coinops-reports/engine-report-scope.ts`: partição das fontes antes de qualquer agregação de relatório.

## Auth, RLS e isolamento

A UI não decide escopo financeiro. O servidor obtém usuário autenticado, tenant configurado e operador proprietário; depois resolve conta e motor. `service_role` permanece exclusivamente server-side. Não é criado cadastro público, portal ou login para titulares futuros das contas Binance.

As tabelas do domínio têm RLS forçada, leitura autenticada limitada ao operador proprietário e escrita administrativa restrita ao backend. Campos `credential_ref`/`executor_profile` da conta não são concedidos ao cliente autenticado. Identidades são imutáveis; alterações administrativas geram eventos sem valores de credenciais.

Decisões são persistidas antes do dispatch, com unicidade por motor + `decision_id`. A persistência, leitura, dispatch, conclusão e falha aplicam o mesmo contexto. Operador explícito incorreto é rejeitado também no caminho de compatibilidade legado.

Leases existentes continuam vinculados ao run/config; esses pais pertencem a um único motor e há unicidade de ciclo ativo por motor. Não foi criado um lock global que serializa contas independentes. Recovery consulta a mesma decisão/ordem e não usa novo ID para contornar resultado incerto.

## Moeda nativa e compatibilidade de dados

Cada engine mantém capital, aporte, lucro, fee, reserva e exposição na própria quote. Não há soma BRL + USDT, soma de contas distintas ou conversão automática para enforcement. Agregados visuais são particionados por conta + ambiente + quote; ausência de evidência continua indisponível, nunca zero inventado.

Para preservar RPCs, dados e claims antigos, algumas colunas físicas LIVE continuam com sufixo `_brl` e tabelas Shadow/Testnet com `_usdc`. A migration acrescenta aliases nativos `_quote`; **o nome legado não autoriza conversão nem troca de moeda**. Nos novos caminhos, `quote_asset` e a engine definem a unidade.

O wire contract do executor também conserva alguns nomes `Brl`. Para motores novos seus valores são nativos da quote validada; o envelope obrigatório elimina ambiguidade. Novas integrações devem consumir a identidade da engine e aliases nativos, não inferir BRL pelo nome do campo. Fees BNB usam a cotação BNB/quote correspondente, com origem auditável.

O catálogo de produto desta fase implementa BTC/SOL com BRL, USDT ou USDC. A estrutura de identidade/quote não depende de BRL, mas isso não equivale a liberar qualquer ativo/par. O adapter Testnet aceita BTCUSDC/SOLUSDC/BTCUSDT/SOLUSDT; BRL Testnet é recusado. O registry do executor é a allowlist efetiva de Production.

## Credenciais, intents e ownership

Fluxo obrigatório Production:

`intent assinada → validar operador/conta/motor/ambiente/símbolo → registry confiável → credential_ref → env server-side → Binance`

O arquivo indicado por `COINOPS_EXECUTOR_REGISTRY_PATH` fica fora do Git, em caminho absoluto, com proprietário root e sem permissão de escrita do serviço. Exemplo operacional de permissões: root/grupo do serviço, arquivo `0640`, diretório `0750`. O exemplo versionado em `apps/live-executor/deploy/account-registry.example.json` contém IDs fictícios e execução desabilitada; não é configuração Production pronta.

O registry vincula IDs persistidos, referência de credencial, perfil `coinops-fixed-ip`, símbolo/base/quote, caps, status, ownership e kills. As referências apontam para **nomes de variáveis**, não valores. Credencial ausente, referência desconhecida ou escopo conflitante falha fechado. Não existe fallback de uma conta nova para a chave Rafael.

Todo POST assinado, inclusive leitura e `/v1/health`, inclui:

- `operator_id`, `exchange_account_id`, `trading_engine_id`;
- `environment`, `symbol`, `quote_asset`;
- `decision_id`, `idempotency_key` igual ao cabeçalho HMAC.

O cliente não pode fornecer chave Binance ou escolher outra `credential_ref` no payload. Respostas devolvem identidade de roteamento e são rejeitadas pelo web se divergirem. Logs sanitizados não incluem corpo de request, assinatura, token ou secret.

`/v1/health` é escopado e autentica a conta selecionada; uma falha de credencial A não se transforma em autorização de B. O GET público `/health` continua diagnóstico de infraestrutura/compatibilidade, não autorização de uma conta.

Rafael mantém exatamente o namespace `COR1` e os clientOrderIds existentes. Para novos motores, `C2` inclui hash de conta+motor, slot físico, lado e hash da operação, respeitando o limite do ID. A resolução completa usa registry e ledger; não depende de nome/email. Somente ordens próprias do contexto podem ser consultadas para recovery ou canceladas. `cancelAllOrders` não é usado.

Os claims COR1 preservam a chave durável e o hash de corpo antigo após retirar o envelope novo; pending/completed sobrevivem ao restart. Claims C2 são separados por conta+motor. Nunca apagar, renomear ou limpar `/var/lib/coinops-live-executor` para resolver um replay.

Testnet possui transporte/origin separado. `COINOPS_TESTNET_ACCOUNTS_JSON` é registry de secrets somente server-side para testes/contas Testnet. Se presente, exige correspondência exata; se ausente, as variáveis Testnet legadas são permitidas somente ao mapeamento legado explícito BTCUSDC/SOLUSDC. Nunca lê credencial Production como fallback. Ordens novas são vinculadas ao run; IDs antigos persistidos continuam recuperáveis.

## Kill switches, cron e monitor

O bloqueio é hierárquico: flags globais do serviço/operador → conta → motor → preparação existente. Bloquear novas entradas em BTC não deve alterar SOL ou outra conta. Novas BUY revalidam contexto, caps e permissões; proteção/reconciliação de posições existentes permanece separada da permissão de abrir exposição. Kill switch não cancela indiscriminadamente TPs residentes válidos.

As frequências existentes são preservadas:

- LIVE execução: a cada minuto, `/api/cron/live-execution`.
- LIVE auditoria: a cada 6 horas, `/api/cron/live-monitor`.
- Testnet reactor: a cada minuto; watchdog: a cada 5 minutos.
- Shadow/market-regime: a cada 5 minutos.

O cron descobre operadores/motores ativos e runs correspondentes; processa cada motor com resultado próprio. Duplicidade de run ativo é erro explícito. O cron é autenticado, depende dos flags existentes e não exige Codex/chat aberto.

O monitor LIVE existente verifica health escopado, GET Binance, ownership, OPEN↔TP, terminal fills reconciliados, 25 slots/contas, gains mensais, identidade contábil dos saldos, exposição/caps, cardinalidade de BUY e frescor de reconciliação. Alertas carregam conta/motor; unicidade é `trading_engine_id,alert_key`. Inconsistência crítica registra alerta e bloqueia novas BUY do motor. O monitor não é uma segunda Strategy Engine nem gera ordens para testar saúde.

Um motor legitimamente bloqueado por meta/cap/kill não precisa inventar NEXT BUY para parecer saudável. Os relatórios distinguem pausa/proteção de divergência e conservam histórico resolvido.

## UI premium e relatórios

A Automação mantém o design system 5.5, com seleção de conta (`Todos` ou conta concreta) e mercado (`Todos os mercados` ou símbolo). A seleção filtra cards, tabela de operações, detalhes, alertas, relatórios e configurações; não muda estado operacional.

A visão Todos apresenta grupos por conta e moeda. Formulários financeiros/configurações operacionais exigem motor concreto; recebem campos de contexto e o backend os revalida. Preview de ajuste manual identifica conta, ambiente, símbolo, slot e quote; ganho/aporte/reversal não podem mudar de motor entre preview e confirmação. Posição OPEN continua preservada, com ajuste efetivo para a próxima operação.

O contrato de relatórios passa a `report_version = 10`, com `operator_id`, `exchange_account_id`, `account_display_name`, `trading_engine_id`, símbolo, ambiente e quote. Fontes são particionadas **antes** da agregação. Snapshot de mercado é da conta + moeda correta, não o primeiro snapshot da conta. A auditoria LIVE nativa não reutiliza o antigo gate que exigia exatamente dois ativos BRL.

`LIVE_EXISTING_LEDGER_SNAPSHOT` indica estado observado, não autorização de ativação nem certificado de saúde. Evidência manual legada sem vínculo inequívoco permanece separada e não é atribuída a outra engine. Exportações são somente leitura e não reconciliam com escrita na exchange. O dashboard reutiliza estado persistido; snapshots GET pontuais de preparação/exportação são agrupados por conta+quote, não polling por render de cada card.

## Onboarding futuro: estado real da implementação

O painel administrativo prepara rascunho de conta/motor `INACTIVE`, kill switch ON, caps/config nativos e IDs reutilizados em retry. Credenciais nunca são digitadas no formulário. Um rascunho não prepara MARKET, não cria posição e não habilita trading.

Checklist persistido:

1. `DRAFT_CONFIG`: configuração administrativa validada.
2. `CREDENTIAL_BOUND`: credencial instalada pelo fluxo seguro do executor.
3. `READ_ONLY`: GET autenticado pelo executor, com identidade conferida.
4. `WHITELIST`: IPv4 `46.101.104.48` autorizado na conta correta.
5. `SPOT_PERMISSION`: permissões verificadas sem habilitar escopos proibidos.
6. `DRY_RUN`: 25 slots, filtros, caps, TP e próxima BUY simulados sem ordens.
7. `ACTIVATION_GATE`: evidência final e autorização de ativação específica.

Nesta implementação, o painel salva o rascunho e executa a verificação GET de motores REAL. Os demais passos são evidência operacional a preencher pelo procedimento server-side autorizado; não são checkboxes que concedem trading. A ativação de conta nova é etapa separada e permanece bloqueada neste painel. A primeira futura segunda conta exige autorização própria, instalação segura da credencial, registry, dados operacionais/configuração e validação dos gates; não é parte do rollout 5.6.

Não clicar em salvar nova conta/amigo nem cadastrar novo par real durante o smoke desta fase. Fixtures A/B demonstram essas capacidades sem cadastrar pessoas ou mover dinheiro.

## Migrations e rollout sem troca de ordens

Histórico remoto confirmado no schema `coinops`, projeto `otdfpmsegjxpqrzisfmi`:

1. `20260924141913_add_multi_account_operator_engine_isolation.sql`: expand/backfill aplicado em 24/09/2026, 14:19 UTC; domínio, identidades, RLS/FKs, aliases, RPCs escopadas, auditoria e onboarding. Mantém compatibilidade dos IDs e contratos financeiros existentes.
2. `20260924142810_optimize_operator_rls_allowed_set.sql`: hotfix RLS aplicado em 24/09/2026, 14:28 UTC. As 34 novas policies consultam uma vez o conjunto autorizado pela RLS de `operators`; as policies anteriores e os dados financeiros não são alterados.
3. `20260924144559_finalize_multi_account_engine_idempotency.sql`: contract aplicado em 24/09/2026, 14:45 UTC, após publicação dos writers novos e encerramento da bridge. Remove chaves globais antigas substituídas por índices por motor; preserva a deduplicação de alertas sem engine com índice parcial por conta. Limites: lock timeout de 3s e statement timeout de 30s, sem alteração de linhas financeiras.

### Incidente de leitura durante o rollout

Após o expand, `/automacao` apresentou erros SQL `57014`/statement timeout, digest `1774318519`. A restrição adicional chamava `coinops_operator_owned(operator_id)` por linha, repetindo a checagem de usuário/vínculo já existente. O hotfix substituiu essa avaliação pelo conjunto de operadores autorizado pela RLS, sem ampliar acesso. Benchmark local com 9.000 eventos: 88,169 ms → 9,097 ms, com uma leitura do conjunto de operadores; testes de usuário, outro operador, DISABLED, master, anon e service_role aprovados. O benchmark não é uma medição produtiva. O Google Chrome autenticado confirmou a recuperação após uma recarga, com cards completos e visual premium preservado no deployment `b18ff25`, às 14:28 UTC. O cron LIVE recuperou o checkpoint transitório de lease durante o DDL; BTC/SOL estavam ACTIVE e sem erro às 14:31 UTC.

### Incidente no restart para encerramento da bridge

O restart das 14:44 UTC, necessário para desabilitar a bridge, interrompeu duas leituras em curso. A proteção `preventNewBuys` registrou `COINOPS_LIVE_READ_STATE_FAILED` no BTC e `COINOPS_LIVE_RECONCILE_ORDERS_FAILED` na SOL, ativando `kill_switch=true` tanto em `trading_engines` quanto nas preparações LIVE dos dois ativos.

Após a recuperação, os runs permaneceram `ACTIVE`, com `last_error=null`, e o cron retomou reconciliações a partir de 14:46 UTC. TPs e próximas BUYs já residentes foram preservados. Isso **não** prova liberação para novas entradas: as flags de proteção continuam ativas e impedem criação/despacho de novas BUYs. Uma BUY já residente continua podendo preencher; não foi cancelada pelo rollout. Nenhuma flag foi reativada para encerrar a fase. `RAFAEL_MIGRATION_PASS` e `MULTI_ACCOUNT_OPERATOR_READY` permanecem pendentes enquanto esse bloqueio operacional persistir, mesmo com health, ledger e ordens residentes íntegros.

Procedimento obrigatório:

1. Confirmar Git/target/schema e recuperar GET Binance Rafael BTCBRL/SOLBRL + ledger. Registrar UTC, runs, slots, clientOrderIds/exchange IDs, fills/fees, TPs, NEXT BUY, caps, saldos e estado de claims. Nenhuma intent incerta pode ser ignorada antes de restart.
2. Aplicar somente a migration expand, após revisão/dry-run suportado. Conferir backfill, relações, valores e IDs preservados. A migration não deve fazer chamadas à Binance, cancelar/recriar ordens ou habilitar motores novos.
3. Gerar registry confiável usando os UUIDs persistidos, somente Rafael BTCBRL/SOLBRL habilitados; preservar flags/caps reais. Não instalar o exemplo fictício.
4. Publicar primeiro o executor compatível. Ativar temporariamente `COINOPS_EXECUTOR_LEGACY_COMPAT=true`, fixar `legacy_account_id` no UUID Rafael e `COINOPS_EXECUTOR_LEGACY_VERSION` na versão exata validada pelo web antigo.
5. Durante a bridge, `/health` expõe versão contratual antiga e também `actual_executor_version`, `legacy_contract_version`, `legacy_compatibility_enabled`. POST `/v1/health` expõe a versão real nova. Apenas payload totalmente antigo, sem envelope parcial, usa mapeamento Rafael estritamente pinado.
6. Publicar o web com contexto obrigatório e `LIVE_EXECUTOR_VALIDATED_VERSION` correspondente ao executor novo. Nunca publicar web novo sobre executor antigo, que não entende health/envelope escopado.
7. Confirmar deployment/commit efetivos e GETs escopados, UI desktop/mobile, ledger, ownership, TPs, NEXT BUY, caps, perfis e reconciliação. Comparar com a Binance, não só com o banco.
8. Drenar invocações antigas; conferir logs sanitizados `legacy_client`. Desabilitar a bridge e reiniciar preservando registry, flags e diretório de estado. Provar que requests sem IDs passam a DENY.
9. Somente após web/executor novos validados, aplicar a migration contract. Conferir índices por motor, replays, relatórios e novamente Binance/ledger. Não remover histórico.

Ordens podem preencher e o cron normal pode criar reentradas durante o rollout. Comparar IDs e trilha temporal permite distinguir operação normal autorizada de efeito indevido da migration; não tratar mudança legítima de status como reset nem declarar preservação sem evidência.

### Rollback

Antes da migration contract, um rollback para web antigo precisa manter o executor compatível e sua bridge estritamente Rafael. Preservar banco expandido, secrets, registry, flags, claims e IDs. Não restaurar executor antigo sob web novo.

Depois da migration contract, o web antigo não possui mais todos os alvos `onConflict` globais de que depende. Portanto não há rollback automático seguro para esses writers: manter versão engine-aware ou corrigir por roll-forward. Recriar constraints antigas exigiria migration revisada e prova de ausência de colisões entre motores; nunca resolver isso removendo linhas.

Divergência operacional exige fail-closed para novas entradas do escopo afetado, recuperação exata e proteção de posições. Rollback não autoriza cancelar TP válido, usar `cancelAllOrders`, limpar claims ou enviar uma nova MARKET para mascarar inconsistência.

Mais detalhes do serviço: [README do executor](../apps/live-executor/README.md).

## Evidência local e critérios de fechamento

Checkpoints executados localmente nesta implementação, sem rede financeira:

- Executor: **23/23 testes PASS**. Fixtures A/B, quatro mercados, seleção de credencial, mismatch de conta/engine/símbolo, ownership, caps nativos, replay/restart, health isolado e bridge temporária.
- Decisões persistidas: **7/7 testes PASS** em `strategy-decision-server.test.ts`. Harness transpila os dois módulos server reais, usa resolver de domínio real e somente o banco é fictício; inclui mesmo decisionId em A/B, rejeição de contexto ausente/incompleto/divergente e continuidade do legado explícito.
- Suíte final de aplicação (incluindo Auth, estratégia, relatórios, execução e modelos da UI): **558/558 PASS**, sem skips.
- SQL/RLS em PostgreSQL efêmero: **21/21 PASS**, incluindo hotfix de desempenho, cobertura dos seis índices substitutos e teste adversarial de alertas sem engine (dedupe/replay por conta).
- Lint global e build Next.js com validação TypeScript: **PASS**.
- UI offline: **17/17 E2E PASS**, mais cinco verificações afetadas pela revisão final. Fixtures, não operações financeiras.

Testes SQL usam banco efêmero, nunca a base Production vinculada. O web `84140f7` foi confirmado READY no domínio canônico. A bridge foi desabilitada às 14:44 UTC; às 14:45 UTC, o executor confirmou health saudável na versão `2205f0b`, sem bridge, e o acesso autenticado legado sem contexto recebeu HTTP 403 `EXECUTOR_CONTEXT_REQUIRED`. GETs escopados de Binance confirmaram as ordens residentes abaixo preservadas. O contract foi então aplicado. Health e GETs confirmam disponibilidade técnica, não o desbloqueio das novas BUYs descrito no incidente acima. Ainda resta concluir o smoke final desktop/mobile da versão publicada e dos relatórios; esses resultados não são inferidos do build ou dos GETs.

| Evidência Binance às 14:45 UTC | TPs residentes preservados | Próxima BUY preservada |
| --- | --- | --- |
| BTCBRL | `2334535032` | `2334960687` |
| SOLBRL | `427993953`, `428035361` | `428035463` |

O monitor server-side de seis horas permanece configurado em `/api/cron/live-monitor`, expressão `0 */6 * * *`. A tentativa manual de GET ao monitor retornou HTTP 401 porque a credencial exigida pela Vercel não estava disponível para exportação. Essa tentativa não foi repetida e **não executou nem validou uma auditoria Production**. A configuração agendada preservada não equivale a evidência de uma execução posterior bem-sucedida.

### Correção do read-model de relatórios LIVE

O smoke do relatório BTC/BRL identificou que os registros brutos LIVE apareciam em `LIVE_EXECUTION.csv`, mas não alimentavam operações/gains, alertas e última execução do resumo; a camada de moedas nativas ainda forçava lucro realizado para indisponível. A correção é exclusivamente de leitura: `SLOT_PROFIT_CREDITED` vincula o TP pelo ciclo, slot e `clientOrderId`, preserva `operation_sequence` e usa o último fill Binance desse TP como instante da realização. A observação/crédito mantém timestamp separado. Gains são apenas operações encerradas com lucro líquido positivo; aportes, ajustes manuais e saldos lifetime não se tornam performance de mercado. Replay de evento não duplica operação, e crédito/TP/fill incompletos produzem ressalva e lucro desconhecido, nunca lucro inventado.

`net_pnl_brl` e demais campos legados do evento representam a moeda nativa definida no motor, sem conversão implícita. Dust retido mantém base de custo separada do delta de caixa. O capital inicial de período continua desconhecido quando não há snapshot histórico; o capital atual permanece o snapshot contábil. Alertas `CRITICAL` entram como erros, com severidade original preservada; checkpoints futuros não são usados em relatório histórico. Nenhuma escrita no ledger, configuração do robô, executor ou exchange faz parte desta correção. A validação publicada do relatório permanece pendente até o novo deploy/smoke.

O link da Automação preserva conta, motor, ambiente e ativo desde a primeira consulta. Seletores desconhecidos ou incompatíveis são bloqueados, sem ampliar silenciosamente para Todos. Exportações incompatíveis com o motor selecionado ficam indisponíveis com explicação. A observação de saúde da UI usa identidade autenticada, no máximo duas consultas concorrentes e orçamento individual de cinco segundos; timeout mantém ATENÇÃO e não altera o timeout financeiro do executor.

Validação adicional local: 63 testes do read-model de relatórios, 15 de seleção/exportação/isolamento e 17 de apresentação/saúde PASS. O complemento visual full-width/home/menu está em commit separado, com 24 E2E cobrindo 360/390/430/1024/1280/1440/1920 e testes Auth direcionados aprovados. Nenhum desses testes opera na exchange.

Snapshot GET Binance pós-contract, às 15:02 UTC: executor `2205f0b` saudável, bridge desligada, os mesmos dois IDs BTC e três IDs SOL da tabela acima continuam NEW. O bloqueio de novas entradas SQL não foi desfeito; health técnico não significa retomada financeira. A publicação final deve conservar essa distinção.

| Gate final da fase | Estado neste documento | Evidência necessária para fechamento |
| --- | --- | --- |
| `MULTI_ACCOUNT_SCHEMA_READY` | PASS | Três migrations aplicadas no alvo correto; schema/RLS/FKs/índices validados no harness SQL, versões locais alinhadas ao histórico remoto. |
| `ACCOUNT_ISOLATION_PASS` | PASS (local) | Adversariais SQL/RLS 21/21, executor 23/23 e aplicação 558/558; isolamento de conta/engine, credenciais, ownership, ajustes e contratos de relatórios cobertos por fixtures, sem criar segunda conta Production. |
| `MULTI_MARKET_MODEL_PASS` | PASS (local) | Fixtures dos quatro mercados, quotes/caps/ledger/gains/rank/ATH independentes; não representa ativação de novo mercado real. |
| `RAFAEL_MIGRATION_PASS` | PENDING | IDs, TPs e BUYs residentes preservados, mas `kill_switch=true` em engines e preparações BTC/SOL após falhas de leitura no restart; novas BUYs continuam bloqueadas. |
| `EXECUTOR_MULTI_ACCOUNT_READY` | PASS (técnico) | Executor `2205f0b`, health/GETs escopados, bridge encerrada às 14:44 UTC, contexto legado negado; replay/recovery cobertos pelos testes. Não certifica novas entradas liberadas. |
| `MULTI_ACCOUNT_UI_READY` | PENDING | Smoke desktop/mobile publicado de Todos/Rafael, mercados, detalhes/config/relatórios. |
| `MULTI_ACCOUNT_OPERATOR_READY` | PENDING | Bloqueio de novas BUYs BTC/SOL ainda ativo; smoke UI/relatórios e fechamento operacional pendentes. Nenhuma segunda conta ou novo par Production ativado. |

PASS nesses gates não autoriza por si só outra conta, outro par, aumento de cap ou operação financeira. Acrescentar ao fechamento SHA final, deployment READY, SHA servido, migrations efetivas, estado LIVE e evidência de zero ordem/cancelamento provocado pela migration; até então esses fatos permanecem não certificados aqui.
