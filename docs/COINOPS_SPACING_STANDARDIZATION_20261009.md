# CoinOps — padronização de spacing BTC/SOL

## Regra autorizada e escopo

Decisão inicial do proprietário em 09/10/2026: novos motores usam o mesmo spacing
antes e depois da ATH, com os defaults abaixo. O esclarecimento posterior do
proprietário preserva exceções individuais já configuradas.

| Ativo/mercados oficiais | `normal_spacing_rate` | `post_ath_spacing_rate` |
|---|---:|---:|
| BTC — BTCBRL / BTCUSDT | 0.02 (2%) | 0.02 (2%) |
| SOL — SOLBRL / SOLUSDT | 0.03 (3%) | 0.03 (3%) |

Esses são os defaults de novos motores, não uma validação que proíba edição
individual. Configurações persistidas nunca recebem defaults por leitura,
restart ou reconciliação. A padronização dos motores existentes é uma atualização
explicitamente autorizada e auditada, não uma migration/seed automática.

Exceção explícita confirmada em 09/10/2026: Rafael mantém spacing normal BTC 1%
(`0.01`) e SOL 1,5% (`0.015`). O pós-ATH desses motores é BTC 2% / SOL 3%, como
nos demais motores selecionados. Não alterar o normal de Rafael, nem classificar
essa diferença intencional como configuração pendente ou incorreta. Uma exceção
individual confirmada e o perfil persistido vencem o default de cadastro.

O cadastro web usa `NEW_ENGINE_STRATEGY_DEFAULTS` e envia os valores explícitos
ao fluxo oficial existente. O helper histórico `OFFICIAL_ATH_DEFAULTS` e as seeds
5%/8% permanecem preservados para compatibilidade: não são os defaults atuais
do formulário de novos motores. Nenhum grafo de runtime do executor é alterado;
esta entrega não exige publicação/restart dos VPS.

Não alterar gain, capital, meta mensal, compounding, aportes, saldos pendentes,
ownership, executor, conta ou estratégia além desses dois parâmetros. Não criar
motores automaticamente quando os slots estiverem ocupados. Cadastro adicional
continua sujeito a saldo, caps, whitelist, Binance e Capacity Admission.

## ATH, slots e snapshots preservados

Manter a Strategy Engine como única autoridade. ATH continua atualizando seu
regime e a fila canônica: até 15 slots elegíveis Primary em ordem crescente de
ganhos históricos; os restantes Reserve em ordem decrescente, liberados conforme
a regra vigente. A fila exclui estados inelegíveis e respeita a prioridade mensal;
igualar spacing não transforma um slot OPEN em PLANNED nem renumera os 25 slots.

`normal_spacing_rate` e `post_ath_spacing_rate` continuam distintos no perfil.
Os defaults iguais fazem o regime deixar de ampliar a distância no cadastro,
sem remover ATH, floor, rank ou grupos. Um motor com exceção individual, como
Rafael, continua usando os valores distintos confirmados. Gain e snapshots de
decisões/ordens já tomadas permanecem congelados. OPEN/TP nunca são
reprecificados para esta tarefa.

## Prévia e aplicação pelo produto

Produto = CoinOps; backend = OnPlay Platform `otdfpmsegjxpqrzisfmi`;
schema = `coinops`; ambiente = REAL. Confirmar GitHub/main, operador, registry de
motores, saúde dos executores/Watchdog e reconciliação recente antes de confirmar.

1. Recuperar perfil, run, regime, versão, gain, meta, capital, slots, OPEN/TP e
   NEXT BUY por `trading_engine_id`; não deduzir parâmetros pelo símbolo/default.
2. No editor em massa, usar um parâmetro por lote. Selecionar somente os motores
   que divergem do alvo expressamente autorizado daquele parâmetro, com valores
   por ativo/mercado quando necessário. Excluir normal de Rafael desta aplicação;
   não criar lote só para eliminar uma exceção intencional. Gerar prévia; conferir
   before/after e NEXT BUY afetadas.
3. Operar sequencialmente por shard, sem pausar a frota. O filtro deve usar o
   executor imutável do motor, nunca o shard bootstrap da conta: uma conta pode
   ter motores em executores diferentes. Dentro do shard, limitar o lote ao
   escopo revisado e esperar sua conclusão antes do próximo.
4. Confirmar pelo fluxo oficial, que chama `enqueue_strategy_bulk_update` e cria
   itens versionados/idempotentes. Registrar `batch_id`, hash, versões, campo e
   valores. Se houver confirmação humana obrigatória, parar nela; não substituí-la
   por SQL, chamadas alternativas ou atualização direta de perfil/ledger.
5. Exigir `APPLIED` por motor. Apenas depois avançar ao outro parâmetro/shard,
   recuperando uma nova prévia sobre o estado e a versão atuais. Não tratar
   `PENDING`/`APPLYING` nem sucesso do botão como conclusão.

Se todos estiverem NORMAL, o campo pós-ATH é do regime inativo e não deve alterar
a BUY residente. A decisão de execução permanece do reconciliador: revalidar o
regime fresco, pois ele pode mudar entre leitura, preview e aplicação.

## NEXT BUY e falhas

Para spacing do regime ativo, o reconciliador oficial exige lease do run,
ownership exato do engine e leitura do estado/fills. Só uma BUY de entrada
comprovadamente sem fill pode passar pelo cancelamento `onlyUnfilled` e pela
substituição canônica. Fill total/parcial concorrente vence: reconciliar e
proteger a posição, sem BUY duplicada. Resposta ambígua não prova cancelamento;
consultar o mesmo `clientOrderId` e preservar o checkpoint.

Não usar cancel-all, MARKET complementar, novo ciclo artificial ou limpeza manual
de alerta/gate. Falha local permanece no engine afetado; OPEN/TP dos demais
motores não são interrompidos. Pendência retomável usa o mesmo lote/cursor
idempotente, conforme `COINOPS_BULK_STRATEGY_RUNBOOK.md`.

## Evidência exigida

- Perfis efetivos pós-ATH: BTC 0.02 e SOL 0.03 nos motores selecionados; normal
  preservado conforme configuração individual autorizada, incluindo Rafael
  BTC 0.01 / SOL 0.015. Itens `APPLIED`, sem `strategy_config_pending` nem edição
  pendente/ambígua. Não exigir igualdade dos dois campos de toda a frota.
- Gains, metas, capital, aportes, slots físicos, OPEN e TP não reescritos pela
  mudança. Diferenças de trading natural precisam de ledger/eventos, não de
  igualdade cega de contadores capturados em horários distintos.
- No máximo uma NEXT BUY ativa por engine, com ownership/versão reconciliados;
  reconciliação recente e ausência de incidente novo causado pela edição.
- Watchdog/executores e cada motor revisados após seu lote, antes de avançar.
- Testes isolados de defaults em ambos os regimes, ATH Primary/Reserve, snapshot
  de OPEN/TP, idempotência, concorrência/fill e isolamento. Não testar criando
  ordens REAL ou forçando ATH em Production.

Relatórios v22 já preservam os dois spacings reais em `REGIME_ATH.csv` e spacing,
gain, versão e evidências LIVE. Não substituir a configuração real por defaults
no export, nem promover ausência de observação a PASS. A padronização não muda
o formato de relatório; os arquivos do runtime executor permanecem inalterados.

## Contexto inicial e aplicação informada pelo proprietário

Na leitura inicial de 09/10/2026 foram identificados 16 motores ACTIVE: 5 BTC e
11 SOL, todos NORMAL. Quatorze já usavam 2%/3% no spacing normal; os dois valores
distintos de Rafael foram depois confirmados como intencionais, não como falha.
Os spacings pós-ATH iniciais eram 5%/8%.

O proprietário informou que aplicou pelo painel o pós-ATH BTC 2% / SOL 3% nos
16 motores. Não repetir a confirmação/aplicação só por retomar a tarefa. A
evidência final server-side deve registrar os lotes `APPLIED`, parâmetros,
versões, saúde e ordens atuais, distinguindo-a dessa fotografia inicial e da
confirmação humana. Defaults publicados e testes locais não substituem essa
evidência operacional, nem autorizam uma alteração adicional no normal de Rafael.

### Conferência server-side após a confirmação

Leituras somente diagnósticas em 10/10/2026, 01:47–01:48 UTC
(09/10/2026, 21:47–21:48 em America/Campo_Grande), no projeto/schema acima:

- Lote SOL `6e6f792e-9cae-4c0d-b153-46d8d7d9fb32`: 11/11 itens `APPLIED`,
  concluído 01:41:36 UTC. Lote BTC `b6de9c56-f396-412f-bc0a-5cddbca917aa`:
  5/5 itens `APPLIED`, concluído 01:41:19 UTC. Único campo atualizado:
  `post_ath_spacing_rate`, respectivamente 8% → 3% e 5% → 2%.
- 16/16 motores e runs ACTIVE, todos NORMAL; zero configuração pendente,
  erro de run, fill não reconciliado ou kill switch de motor. O spacing normal
  efetivo continua 2%/3% nos demais e 1%/1,5% nos dois motores de Rafael.
- Comparação com a fotografia anterior à aplicação: normal, gain, meta, capital
  configurado, compounding e shard inalterados nos 16 motores. São 400 slots
  físicos (25 únicos por motor), 94 posições e 94 TPs residentes. Identidade de
  slot/run/engine, quantidade da posição e identidade/preço/quantidade do TP
  permaneceram exatamente iguais na comparação das 94 posições.
- 16 BUY residentes, uma por motor, todas sem fill parcial e criadas antes da
  fotografia inicial; nenhuma NEXT BUY nova desde 01:38:34 UTC. O regime inativo
  não exigiu reprecificar as entradas residentes. A flag persistida de política
  `requires_order_reconciliation` não é, sozinha, prova de cancelamento executado.
- Watchdog: 16 saudáveis, zero reconciling/recovering/blocked/stale; zero incidente
  Watchdog ou alerta de motor aberto. Executores 01/02/03 HEALTHY, distribuição
  7/7/2, backlog e erros de cinco minutos zero, heartbeat fresco. Runtime comum
  reportado: `66543a8027b4af79ba2a1c4e85a69638b8b4e6db` (sem restart nesta tarefa).

Esta evidência usa o ledger e as reconciliações oficiais recentes (idade máxima
73 segundos), além do painel autenticado exibindo Watchdog HEALTHY e todos os
motores operacionais. Não provocou ordens, fills ou ATH para teste, não repetiu
os lotes e não alterou o normal de Rafael. Não confundir esta observação pontual
com garantia de disponibilidade futura ou prova de um regime pós-ATH observado.

Validação local: 92 testes direcionados, 89 PASS / 0 FAIL / 3 SKIP. Os três testes
SQL requerem PostgreSQL efêmero, indisponível neste notebook; não foram executados
no backend remoto. Lint direcionado, typecheck e build passaram. O build mantém
avisos preexistentes de Supabase/Edge e autoprefixer; nenhum desses módulos foi
alterado. Não há migration nesta entrega. Publicação web e smoke pós-deploy são
checkpoints separados, a confirmar pelo SHA/deployment da entrega.

## Rollback

Rollback é nova prévia prospectiva e versionada sobre o estado atual, respeitando
`NEXT_BUY_RECONCILE`. Não restaurar snapshots de ordens, ressuscitar BUY antiga,
forçar versão ou reexecutar seed histórica. Publicar/reverter web não desfaz uma
configuração já `APPLIED`; separar claramente os dois checkpoints.
