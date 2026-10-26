# Rafael — rank de gains e NEXT BUY (26/10/2026)

## Conclusão e escopo

Não foi encontrado erro na seleção da BUY. O problema era uma ambiguidade de
apresentação: rank de organização e Mês/meta eram vistos como uma fila única de
compras. A única correção é explicativa na UI; comparadores, preços, decisões,
configurações, ledger, leases e runtime financeiro permanecem intactos.

Alvo confirmado: CoinOps, OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`,
REAL, operador `d508bb3e-5a1d-4579-bd7a-de171c118d25`, conta Rafael
`6918a0fa-39fd-423a-bc60-ee8d8ecffb25`, Executor 01 / 46.101.104.48.
Motores: BTCBRL `516530f6-16dc-4617-be9b-ccb32d1d4e57` e SOLBRL
`56d4c9f4-adf5-4d03-9085-87487bcd4af8`. Ambos NORMAL, configuração v3,
25 slots, Strategy Engine 4.3.1. Nenhuma outra conta recebeu mutação.

## Regra efetivamente vigente

- `rankMonthlySlots`: meta/elegibilidade pelo mês-calendário em
  America/Campo_Grande; rank por **lifetime DESC**, empate por número físico ASC.
  OPEN pode ter rank, mas o planner não o aceita como nova entrada.
- `buildPostAthQueue`: seleciona até 15 elegíveis de maior lifetime para PRIMARY,
  organiza PRIMARY por lifetime ASC e os demais RESERVE por lifetime DESC;
  empate por identidade física. Durante o ciclo, grupos/preços persistidos
  continuam valendo. Nenhuma renumeração de slots físicos.
- `planStrategyNextEntry`: somente candidato elegível, PLANNED/ARMED, com preço
  válido abaixo do mercado; **preço DESC antes de rank ASC**, depois físico ASC.
  No pós-ATH, `planStrategyPostAthNextEntry` aplica também a fronteira PRIMARY,
  preservando reentrada e BUY residente. Fill parcial/cruzamento da residente
  exige reconciliação e não autoriza substituição por suposição.
- 25/25 (ou N/N canônico) metas comprovadamente concluídas libera novamente a
  elegibilidade. Não há reset destrutivo na virada do mês/ano; OPEN e TP continuam.

Trocar lifetime por mensal ou colocar gains acima do preço seria uma mudança
econômica da política documentada, não a correção desta apresentação. Não foi
aplicada. Ganhos mensais 4/7, 3/7 e 2/7 ordenam-se nessa sequência quando lifetime
acompanha esses contadores e o preço/estado não impõem precedência; não há uma
garantia de trocar uma BUY residente por um slot de maior contador mensal.

## Evidência BTCBRL — snapshot 12:09Z / Binance 12:10Z

| Físico | Mês/meta | Lifetime | Rank atual / grade | Estado | Preço de reentrada |
|---|---|---|---|---|---|
| #6 | 3/7 | 3 | 5 / 6 | ARMED | R$432.279 |
| #7 | 4/7 | 4 | 3 / 7 | PLANNED | R$427.956 |
| #8 | 2/7 | 2 | 7 / 8 | PLANNED | R$423.676 |

Os três têm evidência mensal íntegra e estão abaixo da meta. #7 não está OPEN,
sem missed/bloqueio registrado e com saldo de slot positivo. Sua elegibilidade
não faz seu preço de R$427.956 ultrapassar a reentrada de #6 a R$432.279.
Ticker observado R$438.237, acima de ambos. O rank exibido concorda com a função
canônica; o rank de grade não foi confundido com o rank corrente.

Cronologia UTC confirmada no ledger imutável:

1. #7 ganhou seu quarto gain do mês no fill `11:27:58.311Z`, creditado
   `11:28:31.701847Z`, e tinha BUY residente a R$427.956.
2. TP #6 preencheu `11:58:00.651Z`; o terceiro gain foi creditado exatamente uma
   vez em `11:58:32.384784Z`.
3. Reentrada #6 preservou R$432.279 e avançou para operação 4 às `11:58:33Z`.
4. Decisão `fe72908234951eb9a4fe03c74d445a19213b8af2849973f8f5fbe1cba13da647`,
   `CANCEL_REPLACE_NEXT_BUY / HIGHER_VALID_ENTRY_HAS_PRIORITY`, criada
   `11:58:36.834058Z`, concluída/ACK `11:58:49.234Z`.
5. A BUY anterior própria #7 `2375283005` foi observada CANCELED com execução zero.
   A BUY atual #6 `2375335894`, client `COR1-BTC-6-4-BUY-c37e3d5ae71868`, está NEW,
   0,00004 BTC, execução zero. Esta auditoria não cancelou/recriou nenhuma ordem.

Assim, a NEXT BUY #6 é correta tanto no ledger quanto na Binance. Se #6 abrir,
o planner pode selecionar #7 caso continue sendo o maior preço válido elegível
naquele novo snapshot; isto é uma projeção condicional, não ordem já enviada.

## Controle SOLBRL e preservação

Binance assinada × ledger: BTC 5 OPEN/5 TP + 1 NEXT BUY (#6); SOL 13 OPEN/13 TP
+ 1 NEXT BUY (#16 a R$505,90), sem execuções parciais. SOL #14/#15 com 2/2 estão
fora de novas entradas; #16/#17 com 1/2 permanecem elegíveis, com preço
R$505,90 antes de R$498,30. Mesma regra canônica, sem exceção por conta.
Health autenticado PASS, ownership por engine/client/order exatos, IP confirmado,
kill switch desligado. Leituras não atômicas; timestamps e IDs delimitam a prova.
O runtime observado é `c9c18356a0949f6c18f0b0b9d0b52fbe700b3992`.

Parâmetros individuais preservados: BTC spacing 1% normal, 2% pós-ATH, gain 1,2%,
meta 7; SOL spacing 1,5% normal, 3% pós-ATH, gain 5,5%, meta 2. A regra 15+10,
gains, aportes, posições, TPs e snapshots históricos não foram reescritos.

## Validação reproduzível, sem LIVE writes

`lib/slotgain/slot-priority-contract.test.ts` reproduz #6/#7/#8, preço empatado,
OPEN/MISSED/meta, gain após planejamento, fill parcial/residente cruzada,
lifetime versus mês, virada mensal/anual, 25/50/100 slots, BTC/SOL, PRIMARY/RESERVE,
reexecução determinística e identidades de motores distintos. Fixtures não são
certificação de capacidade de VPS ou autorização de motor N>25.

Suítes existentes de Strategy Engine, meta mensal, ATH, read model, apresentação
e capital-refresh mantêm os contratos de idempotência/ordens. Nenhum teste
contata Binance ou Supabase remoto. Uma mudança apenas explicativa não exige
migration, novo report_version nem rollout/restart de executores.

Execução local: **99 testes direcionados PASS**, lint direcionado e typecheck
PASS; build isolado PASS, sem credenciais produtivas, com `.env.local` restaurado.
Fingerprint do grafo financeiro permaneceu
`e3f9bf490c8076145862ce77bc1cc7a125146e4b60e5112c15a67364492385b6`.
O grupo adicional `premium-navigation.test.ts` tem 5 PASS/4 FAIL já no
HEAD anterior `8449c7e` (comparação isolada com o fonte daquele commit): asserções
antigas de menu Testnet e estrutura da Home, não alteradas por esta entrega.
Não reativar Testnet nem mudar a Home para fazer essas asserções antigas passarem.
