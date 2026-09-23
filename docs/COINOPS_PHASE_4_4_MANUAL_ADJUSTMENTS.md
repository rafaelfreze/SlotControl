# CoinOps 4.4 — ajustes manuais nos slots Robot V1

Esta fase é exclusiva do Robot V1 em `coinops`: BTC/SOL, Shadow, Spot Testnet fictício e REAL preparado. Não reutiliza o ledger manual legado BTCUSDT/SOLUSDT. Binance Production continua READ-ONLY e LIVE bloqueado; registrar aporte não transfere fundos nem converte moeda na exchange.

## Modelo

- `robot_v1_manual_adjustments` é o ledger imutável. O usuário escolhe ambiente, ativo e slot físico (1–25), motivo e, opcionalmente, observação. Preview e confirmação são separados. A confirmação exige snapshot vigente, chave idempotente e serialização com o lease do motor.
- `MANUAL_TARGET_GAIN` adiciona unidades de gain ao ledger mensal e um crédito financeiro ao saldo. O valor sugerido compõe a taxa configurada sobre o saldo atual; o usuário pode informar valor USD exato. Fica separado de P&L de mercado.
- `MANUAL_CONTRIBUTION` adiciona capital sem alterar gains. USD entra diretamente como USDC lógico. BRL usa o ask público `USDCBRL` Binance Spot, com fonte, taxa e horário guardados; cotação com mais de 120 segundos falha fechada.
- Para OPEN, `balance_usdc` já reflete o crédito, mas BUY preenchida, quantidade, entry, TP e notional comprometido permanecem imutáveis. Quando a posição fechar, o P&L líquido é somado uma vez ao saldo já ajustado. Ex.: 100 + 5 manual + 2 realizado = 107 na próxima operação, enquanto a posição atual continua 100.
- Estorno insere `REVERSAL` vinculado, com valor e gains assinados; não apaga o original. Estorno de gain de mês anterior corrige aquele período e o lifetime, sem descontar a meta do mês corrente.
- O reset Testnet transfere saldo e sua composição manual para o novo ciclo; `gain_count` de mercado permanece local ao ciclo. Meta/rank usam `robot_v1_slot_gain_totals`, cujo lifetime é a soma assinada de mercado e ajustes, sem duplicar o principal.

## Operação e validação

O painel de Automação oferece uma seção compacta de ajustes, seleção de slot, preview de saldo/meta e posição OPEN, confirmação e histórico com estorno. O detalhe de cada slot leva diretamente à seção. O simulador isolado `/automacao/simulador-ajustes` prova cenários A–J sem tocar dados operacionais. Relatórios incluem `AJUSTES_MANUAIS.csv`, ganhos de mercado/manuais separados, aportes e checks com `WARNING` quando falta evidência temporal.

A migration `20260923221727_add_robot_v1_manual_slot_adjustments.sql` é aditiva para saldos e ledger, altera a constraint de balanço Shadow, estende fatos mensais assinados e substitui a view de totais e rank inicial Testnet. Deve ser aplicada apenas ao project ref `otdfpmsegjxpqrzisfmi`, schema `coinops`, antes de publicar o código que seleciona as novas colunas. Não executa ordens nem movimenta capital existente.

Smoke publicado deve ser somente leitura: painel, simulador, exportação, 25 slots por ativo, TP/BUY e reconciliação Shadow/Testnet; **não** confirmar um ajuste real apenas para teste visual. Provas de mutação, concorrência e estorno vêm de testes/simulador isolados; a primeira aplicação por usuário permanece ação explícita com preview.
