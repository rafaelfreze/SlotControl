# Saldo da operação completa — diagnóstico informativo

Decisão de 13/10/2026: quando faltar caixa Spot ou BNB, o ADMIN deve conseguir verificar a operação inteira da conta, não apenas a próxima BUY, e copiar uma explicação para o proprietário. Nenhuma mensagem é enviada automaticamente.

## Comando no painel

Selecionar uma conta em Real → **Verificar saldo da operação completa** → ver detalhes → **Copiar mensagem para o cliente**. Avisos conhecidos de saldo/BNB no resumo permitem abrir diretamente a conta afetada. A verificação é de toda a conta, mesmo com filtro de um mercado, e inclui motores operacionais em shards diferentes.

`GET /api/coinops-live-balances?account=<id>&funding=1` é autenticado/RLS, escopado como Home e somente leitura. Não aceita `ALL` neste modo. O contrato de saldos antigo permanece. A interface reaproveita a consulta existente, limita atualização detalhada a 60s e não instala cron. O executor observa apenas `/v1/state`; nenhuma reconciliação financeira, mutação, trade, conversão ou cancelamento é chamado.

## Conta de principal por moeda nativa

* L: soma dos saldos atuais dos 25 slot_accounts por motor, já com reinvestimento, custos e dust conforme ledger. Não usar cap/25.
* P: aportes seletivos PENDING, ainda não incluídos em L; apresentados separadamente.
* C: custo comprometido das posições existentes, não valor de mercado.
* R: caixa de BUY residentes próprias confirmado por identidade exata; mínimo entre reserva lógica restante e quantidade não executada × preço LIMIT. `PREPARED` não é dinheiro bloqueado comprovado.
* F: caixa livre Spot observado uma única vez por conta/moeda.

`caixa necessário = max(0, L + P - C - R)`

`déficit de principal = max(0, caixa necessário - F)`

O limite autorizado/configurado, saldo Spot bloqueado total e BNB livre ficam separados. Não contar locked externo, Earn, P&L não realizado, lucros futuros de TP ou patrimônio marcado a mercado como caixa disponível. BRL e USDT não são somados ou convertidos.

BNB >0,00001 é apenas o guard técnico atual, não uma reserva que garanta todas as taxas ou ciclos indefinidos. A verificação não inventa uma previsão de taxas. Principal coberto não significa motor HEALTHY, admissão, ordem autorizada, rentabilidade ou ausência de riscos.

## Qualidade e segurança

Roster operacional completo por conta, um ciclo atual por motor, 25 slots/contas físicos únicos, ledger e ordens paginados, reconciliação recente (até 180s), Spot fresco (até 30s), estado/identidade/quantidades dos residentes e posições compatíveis com carteira. Dados faltantes, claim PREPARED, fill pendente, divergência de snapshot, propriedade ou preço não produzem déficit zero: retornam INCOMPLETE. A leitura não atômica é explícita; o reconciliador normal continua sendo a autoridade.

O resultado inclui horário e motivos de incompletude. A UI não apresenta dado antigo como atual, nem copia valor de reposição sem evidência fresca. Dados e valores aparecem somente no painel autenticado e em texto copiado por ação humana, nunca em push de lockscreen, logs, URL financeira ou serviço externo.

Schema confirmado: `robot_v1_live_orders` não possui coluna `symbol`. O diagnóstico resolve o mercado pelo `trading_engine_id` e pelo run vigente exatos, validando também a moeda persistida; nunca inventar coluna nem resolver por conta+símbolo. A regressão de projeção deve conferir os campos reais do schema, além de fixtures.

Essa verificação é informativa: falhar não muda trading, Watchdog, Capacity Manager, capital, estratégia, TPs ou NEXT BUY. Sem migration ou restart de VPS. O relatório v23 já exporta regras técnicas extensíveis; a regra `account_full_operation_funding` documenta o contrato sem alterar layout/semântica dos datasets financeiros existentes.

## Regressões

Mesmo símbolo/conta em shards diferentes; carteira contada uma vez; moedas separadas; 25 slots físicos; cap ≠ alocação; aportes pendentes; reserva parcial com melhoria de preço; locked externo; BNB separado; timestamps; fill concorrente; ownership divergente; falta de dados; auth/RLS/escopo; UI compacta e comando sem ordens.
