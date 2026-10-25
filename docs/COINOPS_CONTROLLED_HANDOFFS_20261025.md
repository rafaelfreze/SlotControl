# Encerramento com gestão do cliente e migração controlada

Decisão expressa do proprietário em 25/10/2026: encerrar o acompanhamento de
Renato e Jenny Mae Maria, mantendo posições e TPs na Binance sob gestão dos
clientes. Migrar **os dois motores da Samya somente 03→02**, após Admission PASS.
Sem vendas, cancelamentos, novo engine, alteração de capital/estratégia ou IP novo.

## Contratos e invariantes

- `engine_handoffs`: evidência persistida com escopo produto/tenant/usuário,
  operador/conta/engine/run, snapshot antes, SHA-256, origem/destino e prova.
  RLS forçado; somente leitura do dono; RPCs de manutenção somente service role.
- Identidades autorizadas são explícitas na migration
  `20261025204059_controlled_engine_handoffs.sql`; não é rebalanceamento automático
  nem API genérica para mover motores financiados.
- OFFBOARDED **não é COMPLETED**. Não altera posições, TPs, slots, fills,
  balances, gains, `completed_at` ou `last_reconciled_at`. Fecha gates do registry,
  desativa o engine/conta e a preparação, preservando histórico. Não há retomada
  automática. TPs podem executar após a entrega sem crédito/reconciliação CoinOps.
- Relatórios v30 mantêm contas arquivadas por caminho de leitura separado;
  o resolver operacional continua recusando contas DISABLED. P&L, caixa e estado
  atual de ordens após offboarding são desconhecidos, não zero ou HEALTHY.
- Native registry é atualizado atomicamente sob lock, com prova das identidades,
  caps e hash dos irmãos intactos. Não atuar sobre static engines: seu fallback
  poderia ressuscitar um writer. Nunca copiar journal, pending claims ou vault.

## Encerramento

1. Recuperar o estado atual e confirmar instrução de gestão assumida pelo cliente.
2. Adquirir lease livre do run PAUSED, sem erro/ambiguidade e sem BUY residente.
3. Capturar snapshot integral 1..25, decisões e dispatches assentados.
4. Conferir Binance assinada × ledger, TPs e ownership exatos antes da mudança.
5. Fechar todas as escritas daquele engine no registry; conferir novamente.
6. CAS do snapshot e lease; persistir OFFBOARDED e evento CLIENT_MANAGED.

`node tools/operations/execute-engine-handoffs.mjs --offboard-clients`

Identidade de pedido determinística por engine/finalidade; replay não repete
encerramento nem contata exchange para produzir operação financeira.
Em 25/10: Renato entregue `21:03:16Z`, Jenny `21:03:44Z`, ambos 7 OPEN/7 TP/0 BUY.

## Migração 03→02

1. Admission canônico para `[25,25]`, reserva única/headroom e histerese intactos.
2. Credencial já instalada: REVALIDATE oficial, UID global igual, whitelist,
   permissões e IP do 02. Reutilização somente pelo relay cifrado autorizado.
3. Capturar **os dois leases na mesma transação**; confirmar zero PREPARED,
   fills não reconciliados, decisões não concluídas, dispatches sem ACK ou claims
   `.pending`. Não apagar nenhum destes para obter PASS.
4. Preparar registry do destino INACTIVE/kill gates fechados e provar leituras
   assinadas dos TPs e NEXT BUY originais. Uma NEXT BUY por engine.
5. Renovar leases, cercar os dois engines no registry da origem e parar/desabilitar
   o serviço no 03. Exigir PID zero, estado inactive e boot desabilitado. A origem
   é exclusiva da Samya e não contém static engines: outros clientes não param.
6. Provar novamente no destino; renovar leases. Commit atômico dos dois handoffs:
   somente shard do engine e compatibilidade bootstrap da conta; preservar todos
   os identificadores e dados financeiros. Triggers só aceitam capacidade interna
   COMMITTING vinculada ao txid atual; demais reatribuições seguem proibidas.
7. Promover somente os engines preparados. Manter leases por 40s: caches de
   roteamento do web expiram em 30s. Soltar somente os leases exatos, sem fabricar
   reconciliação. Confirmar cron normal, Binance × ledger × engine e Watchdog.
8. Somente depois desabilitar o shard no control plane e remover o Droplet03.
   Coletor não consulta shards disabled. Parada de VPS sozinha não encerra custo.

`node tools/operations/execute-engine-handoffs.mjs --migrate-samya`

## Falha ou interrupção

- Sem prova, não fazer cutover. Leases, pendências e erro financeiro não são
  apagados. Fencing da origem sobrevive a restart do processo/host.
- Depois de COMMITTED, só roll-forward; não reabrir a origem por suposição.
- Resposta SQL incerta exige readback do mesmo pedido/prova. Dois COMMITTED não
  exigem nova admissão para +2 nem repetição de migration/ordem.
- Se um estado parcial, lease perdido, fill concorrente, hash divergente ou
  destino inativo for encontrado, manter o menor escopo fechado e investigar.
  Reconciliar pelo fluxo oficial, nunca reenviar ordens para testar.
- Remover uma VPS é irreversível. Confirmar recurso/IP e ausência de obrigações;
  preservar os históricos financeiros no banco. Não contratar snapshot pago
  automaticamente e não transportar segredos ao notebook como backup.

## Validação

SQL em PGlite descartável: namespace/shard imutável, lease/CAS, snapshot alterado,
fill parcial, decisão pendente, ACK, stale proof, capacidade, replay, RLS e grants.
Native fixtures: fencing persistente/idempotente e irmãos intactos; static fallback
recusado; nenhuma cópia de claims/credencial nem transporte de escrita Binance.
Relatórios: gestão pelo cliente, arquivos CSV/JSON e nenhuma leitura histórica
convertida em caixa/P&L/proteção atuais. Nenhum teste cria ordens REAL.
