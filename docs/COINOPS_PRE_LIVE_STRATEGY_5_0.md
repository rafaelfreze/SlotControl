# Fase 5.0 — auditoria adversarial do motor puro

Baseline auditado: `3b967b7d974af46ef715b6369f8d97168cc74ae5`. Correções locais versionam a Strategy Engine para `4.3.1`. Este documento descreve evidência de código/testes; publicação, fotografia remota e gate consolidado pertencem a `COINOPS_PRE_LIVE_AUDIT_5_0.md`.

## Findings e correções

| ID | Severidade | Reprodução / causa | Correção |
| --- | --- | --- | --- |
| STR-01 | HIGH, contrato puro | POST_ATH filtrava um RESERVE `PARTIALLY_FILLED` quando `residentBuy` não era passado; retornava `ARM_NEXT_BUY` no PRIMARY. O mesmo filtro podia ocultar a segunda BUY residente antes da validação. Os adapters atuais normalmente passam evidência explícita, portanto não se afirma duplicação remota. | ARMED/PARTIALLY_FILLED sempre atravessam o filtro; o motor comum protege parcial e rejeita mais de uma residente. |
| STR-02 | MEDIUM | PRIMARY com `operationalRank=null` era considerado disponível e bloqueava a RESERVE válida, embora a própria seleção de entradas o rejeitasse. | Disponibilidade PRIMARY também exige rank elegível. |
| STR-03 | MEDIUM | Último fechamento com todos os 25 slots META BATIDA produzia `GLOBAL_RESET`/REANCHOR. Adapters tinham guardas adicionais contra novo ciclo, mas o contrato emitia decisão indevida. | Motor retorna `MONTHLY_HOLD`; a virada local restaura elegibilidade e permite reset. |
| STR-04 | MEDIUM | Após voltar ao NORMAL, slots empatados eram ordenados por ID lexicográfico (`1,10,11,...,2`) no ladder e por número físico no rank mensal. | NORMAL usa o mesmo desempate por número físico. POST_ATH mantém o desempate por physical_slot_id exigido pela Fase 4.3. |
| STR-05 | MEDIUM | Validação completa de IDs/contagens só ocorria em POST_ATH. Em NORMAL, snapshots com identidades duplicadas congeladas ou contagem mensal maior que lifetime escapavam da validação comum. | Ambos os regimes validam o mesmo conjunto físico e evidência de gains antes de planejar preços. |
| STR-06 | HIGH | ATH t1 → floor t3 → entrega atrasada de novo ATH t2 reabria POST_ATH, pois o bloqueio temporal olhava somente `athObservedAt=t1`. | `lastTransitionAt` usa `transition_observed_at` já persistido. Observação anterior à última transição não altera regime. Varredura histórica completa ainda pode corrigir o ATH sem reverter floor posterior. Não requer coluna nova. |
| STR-07 | HIGH, simulador/evidência | NORMAL inicializava `monthlyTargetReached=false` para todos, mesmo recebendo mensal acima da meta. Cenário 24 bloqueados +1 faltando gain abriu 3 ciclos em 3 candles em vez de permanecer no ciclo1. | Meta/elegibilidade inicial vêm dos dados; último fechamento sem elegíveis não cria ciclo. |
| STR-08 | MEDIUM, simulador/evidência | Ladder duplicado do simulador usava preços teóricos sem tick e identificação de ciclo constante. Podia preencher BUY 100,842 quando ordem válida deveria estar em100,84 e reutilizava operation identity entre resets. | Simulador usa `planAthLadder`, namespace de ciclo e expõe `operationId` em decisões/TPs. Fixtures de consumo da escada passaram a cruzar preços normalizados. |

Seis regressões centrais falharam antes da correção; os testes do simulador também demonstraram abertura indevida de ciclos antes da correção. Os testes novos permanecem no comando `npm test`.

## Evidência executável

- `apps/web/lib/slotgain/audit-5-strategy.test.ts`: 13 cenários de regressão, 25 metas BTC/SOL, reativação mensal, residentes parciais/duplicados, ranks, identidade, ATH temporal, precisão de preço, reset e perfis.
- `apps/web/lib/slotgain/audit-5-strategy-properties.test.ts`: cinco testes, com 6.000 snapshots determinísticos (3.000 BTC +3.000 SOL), seeds `330620` e `328961`; permutação/retry não alteram a decisão, preço válido prevalece sobre rank, meta bloqueia nova entrada e todas as identidades são preservadas.
- Replay longo: 2.000 candles por ativo, 4.000 no total, executado duas vezes para provar reprodução; episódios de subida/queda/ATH/floor, ganhos, reentrada e resets. Uma reconstrução independente por BUY/TP compara principal, P&L, saldo, monthly/lifetime e operação creditada única. Cada ativo deve realizar pelo menos dez operações para impedir um falso PASS por falta de atividade. O teste imprime os totais reproduzíveis de eventos/operações/ciclos.
- Resultado desse replay: BTC 833 eventos, 153 operações realizadas e21 ciclos; SOL315 eventos, 50 operações realizadas e12 ciclos. Ambos mantiveram25 identidades físicas, ledger reconciliado e nenhuma operação creditada duas vezes.
- Viradas: 36 limites mensais em 2024, 2026 e 2028, precisão de1ms em `America/Campo_Grande`; OPEN/reentry congelados e lifetime preservado após rollover duplicado.
- Gain manual/reversal são inputs sintéticos de contagem: promovem/revertem o grupo corretamente; aporte monetário sem gain mantém grupos. Nenhum ledger remoto é alterado.
- Seis snapshots independentes SHADOW/TESTNET/REAL ×BTC/SOL testam parâmetros recebidos. Propostas REAL BTC gain1,2%/spacing1% e SOL gain5,5%/spacing1,5% são apenas cálculo puro; não permitem símbolo BRL nem execução LIVE.
- Núcleo existente de Strategy Engine, mensal, ATH e simulador A–J reexecutado. Typecheck executado e aprovado durante este bloco; a validação integrada final deve constar no relatório principal.
- Comando dirigido abaixo:56/56 testes aprovados, dos quais18 novos adversariais/property/replay.

Comando dirigido (a partir de `apps/web`):

```powershell
node --experimental-strip-types --test lib/slotgain/audit-5-strategy*.test.ts lib/slotgain/ath-regime.test.ts lib/slotgain/monthly-slot-policy.test.ts lib/slotgain/strategy-engine.test.ts lib/slotgain/manual-adjustment-simulator.test.ts
```

## Limites da prova

Os testes puros não provam disponibilidade da Binance, concorrência entre processos, RLS remota, persistência do rollover ou dispatch real. O replay longo tem candles/TPs/reset/meta/ATH; **não** representa partial fills, crashes, FX ou ajustes financeiros persistidos. Esses contratos têm auditoria separada nesta fase. Snapshot equivalente prova determinismo do motor comum; fills SHADOW e Testnet não precisam coincidir.

Não houve escrita em exchange, banco remoto ou operação financeira neste bloco. Production READ-ONLY e LIVE bloqueado permanecem pré-condições; PASS local não habilita LIVE.
