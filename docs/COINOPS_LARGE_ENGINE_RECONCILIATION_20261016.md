# Reconciliação de motores grandes — contrato de segurança

Produto CoinOps / OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`.
Este documento descreve código/testes, não certifica por si só Production ou
autoriza uma ativação. A proposta vigente é Thyely/SOLBRL/50×R$22/Executor03,
capitalR$1100, gain3%, meta3, spacing2%/3%; nenhum motor anterior é redimensionado.
O pedido100×R$11/spacing1%/2% foi substituído pelo proprietário. Testes100 abaixo
continuam como regressão/escala, nunca como parâmetro da nova operação.

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

## Observação coerente de ordens — otimização N>25

O novo endpoint autenticado `/v1/observe-order` exige motor próprio com N>25,
shard/conta/engine exatos e capability `order_observation_protocol=1` no health.
Consulta a ordem uma vez e, quando executada, lê somente seus fills. Os totais
de quantidade e cotação devem concordar. Se houve corrida entre as leituras,
uma confirmação GET da mesma ordem pode estabelecer a coerência; divergência
persistente usa erro transitório tipado de observação, nunca uma ordem repetida.
Identidade inválida, colisão de trade e página incompleta permanecem fechadas.

Uma ordem com execução zero pode retornar trades vazios, mas ausência retorna
`order:null,trades:null`. ACK previamente conhecido ausente tem confirmações
limitadas pelo orçamento GET antes de continuar desconhecido. Nenhum resultado
deste endpoint, isoladamente, autoriza BUY, cancelamento ou resolução de claim.
Após POST oficial, a mesma observação exata assenta o retorno antes do SQL sync.

Em testes de componente: fill estável custa10weight em vez de19; confirmação
de corrida14; observação de execução zero5. São inventários de componentes,
não certificados de carga por minuto. Motores25 conservam o protocolo anterior.

Criação/proteção N>25 também usa contexto local de taxa. O snapshot financeiro
fresco obrigatório pré-POST pode fornecer somente sua cotação BNB; nenhum saldo,
filtro, permissão ou ordem é retido para autorizar outro POST. TP NEW sem trades
não precisa de cotação. Comissão denominada BNB, inclusive zero, continua exigindo
cotação válida na moeda exata, com a mesma expiração60s e identidade completa.

Certificação exige o fluxo ACTIVE integral com budgets compartilhados, relógio,
retries, concorrência, checkpoints e sucessores. Não somar um subconjunto de
componentes nem extrapolar50de25 para declarar upper bound. Regra e limites:
`COINOPS_SLOT_WORKLOAD_CAPACITY_MODEL_20261016.md`.

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

### TP parcialmente executado não significa fill desconhecido

O sync canônico contabiliza cada fill imediatamente, mas conserva
`trades_reconciled=false` até a ordem ser terminal. A migration local
`20261016193756_prove_partial_tp_reconciliation_checkpoint` permite somente
SELL PARTIALLY_FILLED com prova SQL exata: identidade dos fills imutáveis,
somas de quantidade/quote/taxas canônicas, residual da operação e TP residente
correto. Não muda essa flag, não credita gain antecipado e não amplia a exceção
a BUY, estado desconhecido ou soma incompleta. Taxa em base que deixe o TP com
quantidade excessiva continua falhando fechada.

Watchdog solicita um único GET interno service-only por run checkpointado com
TP parcial, nunca por fill. `prove_partial_tp_checkpoint_fills` deriva o conjunto
atual no banco, exige o mesmo checkpoint fresco e retorna fatos exatos de
ordem/posição/taxas. A policy compara esses fatos com sua leitura; corrida,
falha/timeout, checkpoint diferente ou prova ausente não são confirmação.
Timeout/erro de consulta é identificado como
`WATCHDOG_PARTIAL_TP_PROOF_UNAVAILABLE`, permanecendo BLOCKED, sem resolver
incidente financeiro. Negação SQL da prova e BUY/fill realmente incompletos
continuam distintos (`WATCHDOG_FILL_UNRECONCILED`); indisponibilidade não é zero.
Legado25 e caminhos sem parcial não fazem esse GET. Não há nova consulta Binance,
cron ou dataset de observabilidade. Esta implementação local não comprova
aplicação remota nem certificação de capacidade50/100.

### Boundary após uma entrada protegida (motores maiores que25)

Além do slice de120s e do burst de mais de25 TPs terminais, o reconciliador
também encerra uma passagem depois de observar uma BUY com nova quantidade
executada e proteger sua posição, ou reconhecer o TP que faltava após um crash.
Compara fatos persistidos de BUY/TP, não um contador do processo. O boundary
também se aplica após uma entrada criada em ARM_ENTRY: INITIAL_SUBMITTED não
encadeia imediatamente outra BUY no mesmo episódio externo.

Antes de retornar RETRY normal, o helper recarrega ledger e Binance, confirma
ownership, quantidade residual e proteção integral e persiste o checkpoint sob
lease. A próxima execução oficial continua o mesmo run/cursor; não é PAUSED,
não cria uma segunda estratégia nem altera preço, spacing, meta ou gain.
Uma NEXT BUY ainda não determinada será avaliada na próxima passagem normal.
Isso reduz picos por passagem, mas **não constitui sozinho um rate limiter por
IP nem uma prova de máximo por minuto**. A certificação continua independente.

TP parcialmente preenchido permanece PARTIALLY_FILLED e não recebe a flag de
terminal trades_reconciled. Somente a prova SQL dos fills imutáveis, suas somas,
fees, ownership e posição residual pode permitir esse checkpoint; falha ou
ausência dessa prova continua fechada. Não confundir fill parcial já contabilizado
com a confirmação de que a ordem terminou.

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

Relatórios contrato27 exportam checkpoint/evento sanitizado e o contrato de observação, sem lease token
ou credencial e sem substituir o horário de reconciliação. Nenhum cron novo,
infraestrutura paga ou chamada Binance por render é introduzido.

A configuração versionada de `live-execution` foi alinhada em300s no
`vercel.json` e no export da rota. Isso elimina a divergência60/300, mas não é
prova de que Production sofria timeout60 nem garante que todo cenário possível
cabe em300s. O checkpoint120s é cooperativo; o orçamento integral do cron por
shard também precisa caber no limite. A cadência não mudou.

## Evidência histórica anterior à otimização de observação

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
reduzir headroom, inventar PASS ou contornar filtros para liberar. O alvo atual
de50×R$22 exige evidência própria; este inventário histórico100 não o reprova
nem o certifica por herança.
