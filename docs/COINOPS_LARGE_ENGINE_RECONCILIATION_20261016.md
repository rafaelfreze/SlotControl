# Reconciliação de motores grandes — contrato de segurança

Produto CoinOps / OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`.
Este documento descreve código/testes, não certifica por si só Production ou
autoriza uma ativação. A proposta é Thyely/SOLBRL/100×R$11/Executor03,
gain3%, meta3, spacing1%/2%; nenhum motor anterior é redimensionado.

## Causas comprovadas no caminho de 100 fills

O reconciliador lia um snapshot completo por fill apenas para converter BNB;
100 fills tinham inventário de 7.570 weight antes de irmãos/retries. A conclusão
de cada decisão repetia três resoluções do mesmo escopo. Processar todos os
fills, gains e reentradas sequencialmente também podia ultrapassar a execução
web de 300s em cenários de latência conservadora. Baixo uso atual não eliminava
esses problemas. As medidas abaixo não alteram preços, capital ou seleção.

## Fluxo normal

- N>25: cotação BNB da moeda exata, copiada por invocação/engine/run/shard,
  expira em 60s. Promessas de refresh são deduplicadas dentro desse contexto.
  Saldo, posições, filtros e ordens não são guardados para autorizar POST.
- Até quatro SELLs com exchange ACK e identidade própria podem reconciliar
  simultaneamente. Cada SQL sync/ACK/decisão retém a identidade exata. PREPARED,
  BUY, criação e cancelamento não entram nessa fila. Uma falha para a fila e
  aguarda todas as operações já em curso antes de liberar a lease.
- Cada conclusão de decisão resolve autorização fresca uma vez e preserva
  seu CAS, em vez de repetir o registry três vezes. Não há cache de permissão.
- Três retries extras GET compartilhados por invocação grande. Esgotamento
  usa o checkpoint transitório existente; POST/cancel não são repetidos.
  Retries internos de snapshot/relógio do executor também devem ser incluídos
  no inventário da certificação, não são eliminados por esse orçamento.
- Após burst de mais de 25 SELLs terminais novos, o lote protegido pode ser
  retomado pelo cron seguinte. O prazo de 120s é cooperativo, verificado em
  fronteiras seguras; não é um limite absoluto que interrompe uma operação
  financeira em curso. Reconciliação inicial e TP integral antecedem o yield.
- Crédito/reentrada só cedem entre operações totalmente concluídas. O ledger
  é o cursor: terminal já reconciliada, slot CLOSED já creditado e operação
  PLANNED já reciclada não produzem novo efeito ao retomar. Quando todos os
  slots fecharam, a regra canônica decide reset global/successor, não 100
  reentradas locais inventadas. NEXT BUY só é armada após concluir as fases.
- Motores de 25 preservam snapshots por fill, retry e loop serial anteriores.

## Checkpoint persistente e Watchdog

Migration `20261016175026_large_engine_reconciliation_progress_checkpoint`:
coluna nullable `robot_v1_live_runs.reconciliation_checkpoint` e RPC service-only
`record_live_reconciliation_checkpoint(run_id, lease_owner, phase, quantity_step)`.
O RPC INVOKER bloqueia a linha do run, revalida lease por relógio de parede,
identidade/N, gates, ledger completo, ausência de fill pendente e TPs próprios
da operação atual com quantidade correta. Não consulta Binance: a prova fresca
da exchange é obrigação anterior do runtime. Não existe flag do browser que
dispense essa prova.

Contadores derivados do banco (ordens assentadas, gains creditados e sequências)
precisam avançar monotonamente para renovar `observed_at`. Repetir o mesmo estado
não rejuvenesce o checkpoint. O início do episódio é preservado por no máximo
15min; só uma reconciliação completa pode encerrar/reiniciar o episódio.
Eventos de progresso são imutáveis. `last_reconciled_at` só muda no fluxo completo.

Watchdog avalia erro crítico/gates primeiro; checkpoint não esconde ownership,
TP ausente/insuficiente/antigo, fill pendente ou edição BLOCKED_SAFE. Progresso
fresco até150s e episódio até15min significa RECONCILING, nunca HEALTHY nem
permissão para comprar. Perda de progresso volta a ser falha/stale local.
Conclusão integral limpa o checkpoint, preservando eventos históricos.

O sync financeiro existente recebe somente o endurecimento `lease_until <=
clock_timestamp()` após o lock, para não usar a hora antiga de uma transação
que aguardou outra na fila. Preços, taxas, créditos, RLS e ACLs são preservados.

## Certificação e testes

Certificar somente com artefato revisado para count/runtime/política exatos e
sete cenários: steady, fills concentrados, retries, irmãos, recursos, backlog e
fila/rate limit. Fixtures provam comportamento e inventário; não são trades
reais, latência garantida de rede nem prova isolada de capacidade do hardware.
Modelos de tempo devem declarar atraso e paralelismo, nunca apresentar tempo
virtual ou soma de roundtrips como medição de Production.

Relatórios contrato26 exportam checkpoint/evento sanitizado, sem lease token
ou credencial e sem substituir o horário de reconciliação. Nenhum cron novo,
infraestrutura paga ou chamada Binance por render é introduzido.

A configuração versionada de `live-execution` foi alinhada em300s no
`vercel.json` e no export da rota. Isso elimina a divergência60/300, mas não é
prova de que Production sofria timeout60 nem garante que todo cenário possível
cabe em300s. O checkpoint120s é cooperativo; o orçamento integral do cron por
shard também precisa caber no limite. A cadência não mudou.

## Resultado da revisão de certificação

Os testes funcionais não autorizam fabricar `SLOT_WORKLOAD_V1: PASS`.
O inventário conservador revisado de um tick com100observações de fill,
sete snapshots completos com retry interno e três retries externos chega a
`1900 + (7 + 3) × 108 = 2980` weight total. Isso é um envelope de requests por
tick, NÃO uma medição de weight/minuto. Ele não comprova um perfil de2700/min:
faltam a composição temporal do fluxo ACTIVE misto (incluindo parciais e BUY),
as leituras account-global antes de dispatch e invocações sucessivas/recovery.
Público e privado não foram separados para inventar orçamento por IP.

Em16/10/2026 às18:16:29Z, a fórmula oficial retornou no03:
3unidades2700 →3477,07/3900, CAPACITY_OK;
4unidades3600 →4377,07/3900, CAPACITY_REQUIRED.
Isso não significa que100slots consomem exatamente4unidades, nem que o shard
está fisicamente cheio. Significa que o perfil necessário ainda não foi
certificado e o arredondamento conservador seguinte não cabe na política atual.
Não registrar perfil nem alterar headroom/limites para conseguir ativar.

Publicação, SHA, admissão100 e ativação precisam de evidências próprias. Não
reduzir headroom, inventar PASS, contornar filtros ou alterar R$11 para liberar.
