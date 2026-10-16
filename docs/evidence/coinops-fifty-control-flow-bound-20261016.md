# CoinOps: limites de carga do fluxo completo de 50 slots

## Resultado

**Não é um certificado de capacidade.** A redução de N+1 é real (uma ordem
preenchida passa de 19 para 10 weight no segmento order+trades), mas o código
atual não fornece um limite universal de `2700 weight / rolling 60s` apenas a
partir de `slot_count=50`. Contagem de invocação não equivale a contagem/minuto.
Nenhuma consulta Binance real nem mutação Production foi executada nesta análise.

Alvo econômico: 50 × R$22, SOLBRL, gain 3%, meta 3, spacing normal 2%, pós-ATH 3%.
Esta análise usa o código local que contém `ENGINE_ORDER_OBSERVATION_V1` e o
contexto de cotação BNB; não substitui SHA/fingerprint, rollout ou prova de hardware.

## Inventário de componentes

| Componente | Weight | Condição |
| --- | ---: | --- |
| Ordem preenchida, observação coerente nova | 10 | time 1 + order 4 + myTrades(orderId) 5 |
| Confirmação de fill concorrente | +4 | somente se os totais divergirem; nova divergência falha fechada |
| Ordem sem execução / ausência | 5 | time 1 + order 4; ausência nunca autoriza escrita |
| Segmento antigo query+trades | 19 | preservado para os motores de 25 |
| Snapshot financeiro frio | 54 | 30 privado +24 público, incluindo relógios concorrentes |
| Snapshot após query no mesmo transporte | 52 | adapter já tem relógio; permissão faz sua leitura própria |
| Primeiro permission GET 503, segundo snapshot completo | 106 /104 | frio / após query; não é limite universal de todas as falhas |
| Health escopado frio bem-sucedido | 47 | exchangeInfo20 + ticker(symbols)4 + time1 + permission(time1/account20/restrictions1) |
| Cotação ATH | 2 | GET público independente do snapshot |
| Coleta account-global, S símbolos, sem filtro global | 61+46S | time1 + rateLimit40 + exchangeInfo20 + myFilters40S + openOrders6S |
| Coleta com filtro de ordens global | 141+40S | openOrders global80 substitui 6S, não se soma |

Os hosts público e privado são contabilizados juntos conservadoramente. Os pesos
REST são os documentados oficialmente, não o consumo medido da conta. O ticker
com `symbols` custa 4, não 2. Fontes: [Market](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market),
[Account](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account),
[General](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/general).

### Limites adicionais que não podem ser omitidos

- `BinanceSpotAdapter.signedRead` permite uma repetição de relógio `-1021`
  mesmo com `maxReadRetries=0`: account pode acrescentar21; openOrders por
  símbolo acrescenta7 (ou81 para openOrders global).
- `safetySnapshot` faz no máximo dois conjuntos, mas `Promise.all` pode rejeitar
  antes de drenar os demais GETs. Portanto106 é exato para o fixture de
  **permission503**, não um máximo para qualquer ordem de falhas. Dois conjuntos
  frios podem custar108; incluindo os dois retries de relógio, um envelope
  conservador para esse endpoint é164.
- O pool de três repetições externas é por `advanceLiveRunOnce`, não por todo o
  `advanceLiveRun` nem por janela de um minuto. Confirmações de ausência e estado
  inválido consomem esse mesmo pool. POST/DELETE financeiro nunca é repetido por ele.
- Health tem cache20s por engine no executor. É possível reutilizar a resposta
  somente enquanto válida; não se deve declarar uma única health fria em toda
  invocação de300s. Leituras health malsucedidas não ganham cache saudável.
- Cotação BNB tem validade60s e coalescência por contexto. Só a cotação é
  reutilizada; balances, filtros, ordens, leases e autorizações não são cacheados.

## Ramo anterior ao novo boundary: não havia máximo de três POSTs

Um estado de retomada válido pode conter uma BUY `PREPARED` persistida antes do
POST (crash pré-envio). Sob prova oficial de não envio, o fluxo pode fazer:

1. `RECONCILE_ORDERS`: BUY1 → fill/partial fill.
2. `PROTECT_TP`: cancelar o restante parcial de BUY1, se necessário, e criar TP1.
3. Crédito/reciclagem e provas de proteção.
4. `ARM_ENTRY`: NEXT BUY2 → fill/partial fill.
5. `ASSERT_NEW_POSITION`: cancelar o restante parcial de BUY2, se necessário, e
   criar TP2.

São **4 POSTs e até2 DELETEs** no mesmo `advanceLiveRunOnce`, sem duplicação de
ordem nem segunda Strategy Engine. Para evitar o forced-yield de mais de25 TPs
terminais, o ramo pode ter até25 TPs terminais e os demais parcialmente preenchidos.
Se BUY1 já estava reconhecida, o ramo equivalente tem3 POSTs.

### Equação verificável do inventário

O fixture nominal de3 POSTs/0 cancelamentos/50 observações tem exatamente:

`6×54 + 3×(54+52) + 50×10 + 61 + 47 + 2 + 107 = 1359`.

Os61 são os GETs/POSTs fora dos snapshots: TP20 + NEXT BUY21 + TP20.
Uma BUY PREPARED acrescenta117 (a ausência substitui a observação preenchida,
há outro par de snapshots e uma criação). Um cancelamento parcial completo
acrescenta122: query5 + snapshot52 + DELETE1 + observação10 + cotação/snapshot54.

Assim, no mesmo inventário de componentes:

| Ramo | Snapshots completos | 1 símbolo/B107 | 3 símbolos/B199 | 4 símbolos/B245 |
| --- | ---: | ---: | ---: | ---: |
| 3 POST, BUY residente já preenchida | 12 | 1359 | 1451 | 1497 |
| 4 POST, BUY anterior PREPARED | 14 | 1476 | 1568 | 1614 |
| 4 POST +2 cancelamentos parciais | 18 | 1720 | 1812 | 1858 |
| Mesmo ramo, primeiro permission503 em cada snapshot | 18 | 2656 | 2748 | 2794 |

Esta tabela é **derivação estrutural e inventário de componentes**, não afirmação
de um trace completo já reproduzido, nem medição LIVE. O último ramo ainda não
inclui retries externos, coletas adicionais de orçamento, relógio `-1021`,
refresh de cotação ou provas de recuperação de claim. Não deve virar certificado
7/7 PASS por aritmética. Não há latência mínima SQL contratual que exclua um
burst abaixo de60s; um tempo observado em um fixture não prova o máximo geral.

Depois dessa derivação, o agente responsável pelo harness completo reproduziu
o ramo anterior em `tools/testing/variable-engine-full-advance.test.mjs`:
**3352 total =2378 privado +974 público**, rolling60s3352, duração54,5s,
4 POST/2 DELETE,18 permission503 iniciais,3 retries externos,4 mercados,
3 coletas REST completas de orçamento (5 chamadas ao bridge,3 records).
O ledger/proteção convergiu; esse resultado não é uma falha financeira, mas
refuta a assinatura de um envelope2700 para aquele ramo. A reprodução foi
offline, antes da edição do boundary pelo agente principal, e não deve ser
apresentada como consumo medido da Binance.

## Orçamento de conta e continuação

Cada novo POST pode chamar `reserveAccountOrderDispatch`. Se a amostra não tiver
margem de4s, ele pode chamar `collectAccountOrderBudget`, com até3 tentativas
em35s, cooldown5,5s e alinhamento à janela Binance. Para P criações, o limite
estrutural de tentativas é `3P`; isso não significa `3P` coletas frias, pois
cache/coalescência, lease e janela podem reduzir o número real. Só um trace com
tempos e limites canônicos pode fazer essa redução, nunca uma suposição.

A lease de probe45s serializa o proprietário da coleta. Um sucesso libera a
lease imediatamente; não impõe uma coleta/minuto. O cache nativo é por
operador/conta/credencial/símbolos, não por engine; expira na menor janela Binance
ou30s. Uma falha nativa tem cooldown5s.

`continueLiveAdvance` admite até4 passos. Cada passo tem nova lease e novo pool
de três retries. `RETRY` encerra a continuação; `RESTARTED` e `INITIAL_SUBMITTED`
podem continuar imediatamente. Portanto o teto puramente sintático de retries
externos é12 por chamada encadeada, não3. O sucesso de um predecessor e sua
sucessão não autoriza outra BUY sem as provas oficiais novas.

## Rolling60s e concorrência

- EXECUTION é agendado a cada minuto; MONITOR a cada6h; Watchdog a cada minuto.
- Watchdog saudável não faz Binance REST. Lease vigente e checkpoint válido
  classificam reconciliação sem iniciar outro recovery. Stale elegível pode
  chamar o reconciliador oficial (até2 candidatos por shard).
- A lease do engine impede duas execuções concorrentes do mesmo run, **não**
  impede duas execuções sequenciais no mesmo minuto e é liberada entre hops.
- Jitter/atraso de cron, fronteira da janela, recovery e comandos administrativos
  autenticados não são uma hipótese de zero tráfego. MONITOR também adquire a
  lease, mas uma auditoria não atualiza `last_reconciled_at`.
- Os4 workers/shard limitam concorrência, não weight/minuto. O slice120s não
  limita um burst que termina antes de120s.

Não há no código lido uma reserva REQUEST_WEIGHT por IP/rolling60s que possa
transformar o limite de uma invocação em garantia universal por minuto. Sem uma
hipótese operacional comprovada sobre admissões por janela, ou um envelope de
peso real por IP, não é correto assinar esse máximo.

## Menor checkpoint cooperativo recomendado

Para motores N>25, observar se alguma BUY aumentou `executed_quantity` nesta
passagem (inclui BUY já residente/ACK, não apenas um POST recém-enviado). Depois
de reconciliar completamente essa entrada, cancelar eventual restante parcial,
proteger TP e provar integralmente Binance × ledger, pode-se persistir um
checkpoint normal e retornar `RETRY`, sem executar outra `ARM_ENTRY` nem seguir
imediatamente a continuação. Não bloquear TP/fill/gain nem os irmãos.

O checkpoint existente `CREDIT_SLOTS` serve ao boundary pré-crédito somente se
todos seus gates SQL verdadeiros forem satisfeitos: lease, identidade, zero fill
pendente, posições protegidas, contadores monotônicos e janela15min. Uma BUY
parcial ainda residente sem proteção exata **não** qualifica. Não atualizar
`last_reconciled_at` como se o trabalho pendente tivesse acabado.

Essa alteração reduz o ramo composto, mas **sozinha não garante rolling60s**.
Também precisa evitar um episódio saudável eterno de checkpoint (15min) e
definir como a operação termina/retoma, com teste de crash e limite de geração.
Uma garantia universal de peso exige contabilizar/reservar o envelope por IP,
antes de trabalho discricionário de nova entrada, preservando a reserva de
proteção/recovery e sem adiar TP necessário. Não introduzir isso silenciosamente
para conseguir um PASS. Esta é recomendação, sem edição de runtime nesta etapa.

### Revisão do boundary implementado durante esta análise

O agente principal acrescentou a prova de aumento de quantidade BUY ou de novo
ACK TP antes de `CREDIT_SLOTS`, e força o checkpoint existente após
`ensureTakeProfits`. O gate financeiro permanece no RPC existente. A comparação
usa fatos carregados do ledger no início da passagem; não cria autorização de
ordem. A revisão independente não encontrou bypass de ownership/TP/fill nesse
boundary.

Limites ainda importantes:

1. Para o estado normal com no máximo uma entrada a proteger, o early boundary
   reduz a passagem PREPARED-BUY parcial para2 POST/1 DELETE. Se faltam TPs de N
   posições porque foram cancelados/expiraram externamente, `ensureTakeProfits`
   pode criar N proteções antes de poder provar/yield; não é máximo2 global.
2. Um run vazio ainda pode chegar a `ARM_ENTRY`, criar MARKET+TP e retornar
   `OK/INITIAL_SUBMITTED`. A continuação pode iniciar outro passo imediatamente
   e criar NEXT+TP. O boundary somente antes de crédito não impede esse ramo.
   Um boundary equivalente após a nova posição estar protegida, sem continuação
   imediata, precisa ser tratado/testado separadamente.
3. Early slice normal:3 snapshots fixos +4 para2 criações +2 para cancelamento
   parcial =9. Inventário com3 mercados/1 coleta199:1273 nominal; permission503
   em9 snapshots:1741; três retries externos de state106:2059. Se as duas
   criações precisam cada uma de3 coletas frias, o limite conservador sobe para
   3054 (acrescentar5×199), ainda sem clock drift/filtro global.
4. Slice que já chegou a ARM:6 snapshots fixos +4 para2 criações +2 para cancel
   =12, não9. Inventário análogo:1447 nominal,2071 com12 permission503,
   2389 com três retries externos state106,3384 com mais5 coletas199. Esses
   são limites/inventários condicionais, não novos traces completos executados.
5. Entre duas invocações que liberaram a lease o intervalo mínimo imposto pelo
   código é **zero**. A cadência configurada normal é60s; isso não é rate limiter
   de rolling60 nem garantia contra jitter/replay manual. Não alterar a cadência
   para fazer a aritmética caber.
6. Um episódio legítimo de checkpoint continua limitado a15min. Uma sequência
   infinita de entradas/fills não pode manter o motor eternamente RECONCILING
   nem renovar o relógio sem progresso. Fechamento e nova geração precisam
   preservar a diferença entre observação financeira completa e trabalho
   discricionário ainda pendente.

## Prova executável: seis coletas completas cabem na janela

Arquivo: `tools/testing/account-budget-window-workload.test.mjs`, **6/6 PASS**.
Ele executa o collector web canônico, `readAccountOrderBudget`,
`createAccountOrderBudgetReader` e `BinanceLiveTransport` reais, com transporte,
resolver, banco e relógio isolados. Não implementa outra estratégia. Não há
env/vault, DB remoto ou POST/DELETE financeiro.

O caso de counter crossing nativo é diferente da amostra válida rejeitada por
`WINDOW_MARGIN` no web: ele retorna `EXECUTOR_ACCOUNT_ORDER_BUDGET_UNKNOWN`,
portanto o collector usa cooldown5,5s, não alinhamento via amostra validada.

Com offset0 e janela ORDERS10s, estes tempos relativos ao início do minuto
passam pelo código real:

| Probe | Início | Fim | Resultado |
| --- | ---: | ---: | --- |
| A1 | 9,999s | 10,000s | counter crossing após inventário completo |
| A2 | 15,500s | 20,000s | counter crossing após inventário completo |
| A3 | 25,500s | 25,500s | PASS, margem4,500s |
| B1 | 30,001s | 40,001s | counter crossing após inventário completo |
| B2 | 45,501s | 50,001s | counter crossing após inventário completo |
| B3 | 55,501s | 55,501s | PASS, margem4,499s |

Os loops custam15,501s e25,500s, cada um abaixo do deadline35s. O total do
witness é45,502s. B1 divide seus10s entre um GET myFilters5s e o último GET
openOrders5s, preservando o timeout8s de cada GET e o HTTP20s do probe. A coleta
A retorna com margem para um dispatch, e antes de B o relógio avança até o
vencimento verdadeiro da amostra A. Cache, failedUntil5s e lease própria são
respeitados, não ignorados.

Há também um caso com **10ms positivos por GET**, não só GET instantâneo:
45,862s no total, mantendo as duas margens acima de4s. Os10ms são latência
sintética, não estimativa de RTT Production. Com3 mercados sem filtro global,
os seis probes custam1194; com4 mercados/filtro global,1806. Cada probe inclui
todos os myFilters/openOrders exigidos, mesmo quando acaba rejeitado.

Isto refuta a exclusão de seis probes por alinhamento/cooldown. Não prova que a
soma inteira de todos os ramos financeiros acontece nesses mesmos tempos, nem
é medição LIVE. O fixture full-advance continua necessário para compor os
probes com o resto do pipeline e registrar o máximo rolling60s.

### Correção do protocolo de counter crossing e repetição do witness

O testemunho de seis probes acima permanece executável em modo explícito de
compatibilidade com a resposta antiga503. A implementação nova termina o
inventário e responde409 tipado `EXECUTOR_ACCOUNT_ORDER_BUDGET_WINDOW_EXPIRED`,
com a amostra **original** completa e o mesmo escopo assinado da leitura200.
Não altera timestamps, contadores, validade ou reserva. Idade superior a30s,
offset inválido, inventário incompleto e erro de provider continuam falhas.

O collector valida todos os campos, identidade, runtime, filtros e ordens no
`observedAt` original antes de aceitar somente a informação de alinhamento.
Amostra409 nunca é gravada nem autoriza dispatch; a próxima leitura200 precisa
ser fresca e satisfazer novamente a margem4s. Uma resposta409 fresca/forjada,
estrangeira ou malformada não recebe retry. O web antigo falha fechado ao409;
o web novo conserva compatibilidade com o503 do executor antigo.

Com as mesmas respostas atrasadas, o caminho novo passa por quatro coletas:

| Probe | Início | Fim | Resultado |
| --- | ---: | ---: | --- |
| A1 | 9,999s | 10,000s |409 completo; alinhamento validado de10,000s |
| A2 | 20,000s | 24,500s | PASS, margem5,500s |
| B1 | 30,001s | 40,001s |409 completo; alinhamento validado de9,999s |
| B2 | 50,000s | 54,500s | PASS, margem5,500s |

Elapsed44,501s; peso796 para3 mercados sem filtro global e1204 para4 mercados
com filtro global, contra1194/1806 no witness legado. Os testes também recusam
conta/shard/IP estrangeiros, símbolos vazios, versão não revisada e409 que ainda
não cruzou sua janela; nenhum desses casos persiste amostra. Isso elimina a
repetição comprovada deste ramo sem reduzir gates, retries ou headroom. **Não é
por si só um upper bound do advance completo, nem certificado de carga50.**

### Fontes reais de execução e limite da conclusão temporal

No código revisado, `advanceLiveRun` é chamado somente pelo cron EXECUTION e
pela recuperação elegível do Watchdog. MONITOR usa `auditLiveRun`; checkpoint
válido produz RECONCILING não recuperável. Leituras da interface não avançam o
motor. A API administrativa não aceita ação RECONCILE; RESUME de ACTIVE saudável
é recusado pelo gate/preparation, e retomada não chama `advanceLiveRun`.

A configuração normal de EXECUTION é uma vez por minuto, mas a autenticação
privilegiada do cron não equivale a um rate limiter de rolling60s. Uma requisição
manual autorizada/replay do próprio cron continua tecnicamente possível; leases
evitam concorrência financeira, não imporiam espaçamento após liberação. Assim,
prova por invocação/cadência normal deve declarar esse modelo e não ser apresentada
como limite universal contra chamadas administrativas arbitrárias.

## Comparação25 / informação100

25 continua no protocolo legado: observação preenchida19 e cotação/snapshot54
por reconciliação alterada, quando aplicável; não foi reescrito para satisfazer
o alvo50. N>25 usa observação10, contexto de cotação e pool de4 SELLs, mas
compartilha a mesma semântica financeira. Para100, o forced-yield após mais de25
SELLs recém-terminais reduz a continuação concentrada; fills parciais não são
terminais, portanto não herdam automaticamente essa prova. Nem50 nem100 podem
ser certificados por `ceil(N/25)` ou apenas pelo probe de transporte.
