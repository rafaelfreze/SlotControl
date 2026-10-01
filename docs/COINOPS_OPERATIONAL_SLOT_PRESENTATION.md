# CoinOps — ordem operacional e virada mensal

## Contrato único de apresentação (01/10/2026)

`apps/web/lib/slotgain/operational-slot-order.ts` é o comparador compartilhado:

1. OPEN / TP_ACTIVE / posição parcial;
2. ARMED / NEXT_BUY;
3. reentrada e demais estados operacionais elegíveis;
4. PLANNED;
5. estados não operacionais, sem converter erro/MISSED em oportunidade.

Dentro do grupo: rank vigente da Strategy Engine, depois número físico como
desempate determinístico. Rank ausente fica ao fim do grupo, sem rank inventado.
O comparador copia a lista e nunca escreve no ledger, preços ou estratégia.

`live-slot-read-model.ts` usa a função existente `rankMonthlySlots`, no servidor,
com os totais do ledger e a meta configurada. Replica a fronteira de `candidate()`:
NORMAL usa rank mensal vigente; pós-ATH preserva rank persistido PRIMARY/RESERVE
enquanto elegível. `grid_operational_rank` conserva a evidência da grade; não é
necessário reordenar/reprecificar o ciclo ou escrever ranks no banco para exibir
o rank corrente. Preço válido continua sendo escolhido pela Engine antes do rank
como desempate — esta ordem visual não emite decisões de compra.

A lista premium, posições, detalhes, Estratégia, painel operacional legado,
seletor/aporte e portal VIEWER compartilham essa ordem. Filtros explícitos de
slot físico ou gains continuam análises identificadas, não a ordem operacional
padrão. Histórico de fills, replay do simulador ATH e relatórios cronológicos
mantêm sua cronologia; ordenar essas linhas por estado falsificaria o histórico.
O simulador de ganhos agrega saldos, não define uma fila de execução.

## Mês/meta e identidade

O calendário continua `America/Campo_Grande`. 01/10/2026 e 01/01/2027 começam
às 04:00Z. A view de totais filtra o `period_key` corrente; não existe reset
destrutivo. Depois da meia-noite local, Mês/meta é 0/meta até novos créditos
do mês. Lifetime, P&L, ID/número físico, OPEN, TP e NEXT BUY não são apagados.
25/25 acima da meta libera novamente a elegibilidade: meta é piso, nunca stop.

Exibir separadamente slot físico, rank operacional, estado, Mês/meta e gains
totais. Um OPEN acima da meta continua OPEN e protegido; um NEXT continua
identificável, mesmo se o rank estiver indisponível.

## Presets

`1 OPEN + 4 seguintes` e `2 OPEN + 3 seguintes` usam o mesmo comparador e os
mesmos ranks projetados no GET, preview e confirmação do backend. OPEN forma
o prefixo; seguintes são as próximas linhas operacionais, incluindo NEXT BUY.
Uma região não dá a volta ao final da lista. Empates de rank são permitidos
com desempate físico; conjunto incompleto, identidade duplicada ou rank
ausente não produz seleção certificada. Mais de uma âncora continua exigindo
escolha. Preview mostra números físicos exatos; re-resolução e fingerprint
vigentes impedem aplicar uma seleção antiga. Sem aportes reais no smoke.

## Auditoria de leitura

Relatórios v15 mantêm `operational_rank` bruto e acrescentam, somente para
snapshot atual comprovado, `current_operational_rank`, `grid_operational_rank`,
`visual_order`, `monthly_gain_count`, `monthly_gain_target`, `lifetime_gain_count`,
`period_key` e `presentation_basis` em LIVE_EXECUTION. Sem fonte completa ou
com cutoff histórico não se infere rank atual/estado passado. Exports continuam
somente leitura, sem coleta de ordens ou reconciliação financeira.

Leitura Production em 01/10/2026: 13 motores ACTIVE, kill switches OFF e
reconciliação recente. Rafael/BTCBRL NORMAL: #2 OPEN, #1 ARMED, demais PLANNED.
UI anterior: #2 → #4 → #1 → #5 → #3 → #6 (ranks de grade repetidos).
Read model corrigido: #2 → #1 → #3 → #4 → #5 → #6.
#2: 0/7 em outubro, 4 lifetime. Total BTC: 8 créditos setembro + 2 outubro.
TP #2 448488, NEXT #1 438752 permanecem no ledger. Estas são evidências
datadas, não valores fixos nem metas a serem implantadas.

Testes: BTC/SOL, limites setembro/outubro e dezembro/janeiro, all below/above,
meta parcial, rank empatado/ausente, pós-ATH, imutabilidade, presets, export e
render responsivo 390/1440. Nenhuma migration ou publicação de executor é
necessária: nenhuma mudança no grafo de execução LIVE ou na estratégia.
