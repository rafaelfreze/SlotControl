# Fase 5.0 — execução, fills e recovery

Escopo local: baseline `3b967b7d974af46ef715b6369f8d97168cc74ae5`, branch `main`,
origin `https://github.com/rafaelfreze/SlotControl.git`. A inspeção desta trilha não
fez chamada Binance autenticada, operação em DB remoto, commit ou deploy. As
evidências remotas e o SHA final pertencem ao relatório consolidado.

## Findings comprovados e correções

| ID | Severidade | Falha | Correção / evidência |
| --- | --- | --- | --- |
| EXEC-01 | HIGH | BUY com 10%, 50% ou 99% executado seguida de CANCELED/EXPIRED nunca fechava: o runtime exigia BUY `FILLED`. | Contabilidade baseada em quantidades e terminais reconciliados, inclusive `EXPIRED_IN_MATCH`. Nove cenários de regressão executam o helper usado pelo runtime. |
| EXEC-02 | HIGH | Terminal parcial não-FILLED era ignorado mesmo com trades/fees não reconciliados. | Terminal executado continua sincronizando até reconciliar; fechamento recusa trades incompletos. |
| EXEC-03 | HIGH | Cancelamento troca clientOrderId; leitura dos fills só buscava pelo clientId antigo. | Recuperação pelo exchange orderId persistido e escopo original validado. Teste com cancel-renamed e somente GET. |
| EXEC-04 | MEDIUM | Mais de 100 trades por ordem truncavam permanentemente a reconciliação. | Paginação `orderId + fromId`, 1000 registros/página, teto de dez páginas, dedupe por tradeId e recusa de colisões; 1001 fills comprovados. |
| EXEC-05 | HIGH | LOT_SIZE de LIMIT/TP era substituído por MARKET_LOT_SIZE quando ambos positivos. | Ladder/TP usam LOT_SIZE; MARKET inicial é quoteOrderQty. Teste com steps diferentes confirma filtro correto. |
| EXEC-06 | HIGH | Worker podia continuar depois da lease de 90 segundos, em etapas não cobertas pelo deadline. | Renovação CAS por owner e lease ainda válida antes das mutações críticas e imediatamente antes de POST/DELETE Binance. Lease perdida/expirada falha fechada; fake clock e troca de owner comprovados. |
| EXEC-07 | HIGH | Crédito Testnet fazia PATCH de saldo absoluto após leitura, podendo perder ajuste manual concorrente. | `credit_robot_v1_testnet_closed_slot` trava run/slot, recalcula e credita atomicamente; implementação/testes PostgreSQL na trilha ledger. Runtime passa identidade/sequence/quantityStep/leaseOwner, sem saldo/profit confiado ao caller. |
| EXEC-08 | MEDIUM | Partial abaixo de MIN_NOTIONAL não tinha TP e não gerava falha explícita. | Evento `TP_UNCOVERED_FILTER_LIMIT` e erro ativo suspendem novas entradas enquanto não for possível proteger; não vende quantidade inexistente nem cria ordem inválida. |
| EXEC-09 | HIGH | INITIAL MARKET rejeitada/expirada com zero fill pulava para a fila LIMIT sem abrir posição inicial. | Retry inicial apenas quando nenhuma BUY executou ou permanece ativa, com revision monotônica e identidade nova. Aquisição histórica impede repetir initial. |
| EXEC-10 | MEDIUM | Evidência de ordem aceitava NaN/negativo e incompatibilidade de side/symbol no adapter. | Resposta inválida é rejeitada antes da contabilidade; trades também validam side e identity. |
| EXEC-11 | HIGH | POST com ACK perdido seguido de -2013 inconclusivo em outra invocação podia reenviar a mesma identidade após fill. | Permissão de submissão consumida por CAS e marcador imutável antes do POST. Após marker, recovery só consulta; 20 invocações novas inconclusivas geram zero POST adicional e recuperam quando a ordem fica visível. |
| EXEC-12 | HIGH | Gain manual após preparar/armar uma BUY podia atingir a meta, mas recovery Testnet e fill Shadow usavam a elegibilidade antiga. | Revalidação mensal durável sob lease antes do primeiro POST Testnet ou de materializar BUY_TRIGGERED Shadow. PREPARED comprovadamente não enviado é cancelado localmente; ordem incerta continua GET-only. Cinco regressões exercitam o runtime com INITIAL, ENTRY, ARMED, meta e virada de mês. |

Contabilidade terminal: comprado líquido = soma de BUY.executed menos BUY.fee_base;
vendido = soma de SELL.executed mais SELL.fee_base. Fechamento exige todas as ordens
terminais e reconciliadas, nenhuma fee sem conversão, ausência de oversell e
resíduo menor que quantityStep. P&L = proceeds líquidos menos custo efetivamente
executado; principal reservado e parcela não executada nunca viram lucro. Resíduo
de arredondamento permanece explícito em `remainingDust`.

## Matriz de recovery

| Fronteira | Prova e comportamento |
| --- | --- |
| Decision antes de dispatch | Intenção persistida e identidades determinísticas; não declara ACK sem ordem. |
| Ordem criada sem persistir resposta | GET por clientOrderId recupera a ordem; marcador durável impede POST adicional mesmo em nova invocação com consulta inconclusiva. |
| Fill sem persistir ledger | Leitura de order + trades recompõe quantidades/fees; event keys de fill deduplicam. |
| TP criado sem persistir resposta | Mesma recuperação por identidade; actual-runtime harness valida revision/operation sequence, NEW/PARTIALLY_FILLED/FILLED. |
| TP fill antes de gain | Contabilidade pura e RPC atômica deduplicada pelo fechamento/operation sequence. |
| Gain antes de reentry | Crédito guardado; reentry preserva physical slot, incrementa operation_sequence e balance composto. Testes de recovery verificam snapshot exato. |
| Cancel ACK perdido | Consulta pelo exchange orderId após clientId renomeado; só cancela NEW e ownership exato. |
| NEXT BUY ACK perdido | GET-only após consumir guard; uma ordem residente existente impede outro next. |
| Cycle complete antes de reanchor | Reset key estável e successor persistido; helper não infere successor. |
| Initial MARKET antes de TP | Sync recupera BUY; proteção usa quantidade realmente comprada menos fees. |
| BUY terminal parcial | Agora encerra após vendas reconciliadas, sem exigir status FILLED. |
| TP parcial | Quantidade executada + restante reservado não pode exceder base adquirida. |
| Lease expirada / outro owner | CAS recusa renovação e zero POST/DELETE no teste de interleaving. |
| Ajuste/reversal/rollover/ATH | Cobertura consolidada nas trilhas ledger/strategy; não duplicada aqui. |

## Observabilidade e limites

`SLOT_CLOSED` inclui quantityStep, closingSellClientOrderId, remainingDust e
terminalStatus. A RPC de crédito publica os eventos e o saldo na mesma transação.
`TP_UNCOVERED_FILTER_LIMIT` inclui quantidade descoberta, preço alvo, filtros e
ação de recovery. Eventos entram no export de eventos Testnet; `last_error`
impede health saudável enquanto a cobertura estiver bloqueada.

`SUBMISSION_GUARDED` registra consumo da única permissão de envio, com
`exchange_acknowledged=false`; nunca serve de prova de envio, ACK ou fill.
`submission_guarded_at` é imutável. A migration
`20260923231734_guard_testnet_order_submission.sql` preserva ordens PREPARED
anteriores como incertas, usando o instante da migration sem inventar dispatch
histórico. `COINOPS_TESTNET_SUBMISSION_OUTCOME_UNKNOWN` mantém novas escritas
bloqueadas enquanto o GET não comprovar o estado.

Durante o intervalo migration/deploy, o default marca inserções de código legado
como incertas. O runtime novo insere NULL explicitamente e consome o permit por
CAS. Isso protege a retomada pelo código novo; não transforma workers antigos
ainda em execução em workers com a proteção nova.

Partial abaixo de filtros não pode receber TP residente válido até acumular
quantidade suficiente. O sistema bloqueia novas entradas e sinaliza a ocorrência;
isso não equivale a declarar uma posição pequena protegida. Dust inferior a um
step é contabilizado explicitamente, nunca descartado silenciosamente.

As leases renovadas protegem contra worker expirado e os créditos financeiros são
atômicos em SQL. Isso não prova inexistência de toda falha distribuída possível.
Transportes Binance têm timeout de oito segundos e o lease vale noventa segundos;
não foi simulado crash real do processo Vercel nem falha real da Binance nesta
trilha. Os testes usam estado isolado, fake clock e transportes em memória.

O endpoint ticker/price não fornece timestamp do último trade; `observedAt` é a
coleta, não prova temporal do trade. Timeouts falham fechados. Não afirmar prova
de websocket persistente ou tempo máximo real de reconciliação sem evidência
remota correspondente.

Crash depois do marcador e antes de POST é indistinguível de POST cujo resultado
continua desconhecido. O sistema escolhe bloquear com erro explícito e zero
reenvio; isso preserva segurança, mas não promete convergência automática sem
evidência externa. Nenhuma rotina limpa o marcador para tentar novamente.

## Validação local desta trilha

Executados inicialmente 57 testes direcionados com PASS, incluindo 24 adversariais
novos, testes existentes de adapter, cycle, recovery, ATH transition e TP/reentry
real via harness. Após o gate mensal e a correção de expectativa LOT_SIZE, 43
testes direcionados passaram, incluindo cinco novas regressões de revalidação
mensal nos dois runtimes; typecheck PASS. Suíte/lint/build finais e evidências de publicação
devem usar o SHA consolidado, conforme relatório principal.

Documentação primária usada: [Account trade list](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account)
para paginação por orderId/fromId e [Cancel order](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/trade)
para ONLY_NEW e troca de clientOrderId.

Production permaneceu READ-ONLY, LIVE bloqueado; zero operação financeira real.
