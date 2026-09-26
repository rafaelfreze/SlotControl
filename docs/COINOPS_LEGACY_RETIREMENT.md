# Retirada do CoinOps manual

## Contrato vigente

CoinOps Automation é o único produto ativo. Entradas, gains, TP, NEXT BUY,
slots e ciclos operacionais são executados pelos motores LIVE/Testnet, com
ledger e reconciliação server-side. Não se cria operação manual pelo navegador.

## Removido

- `/dashboard`, `/slots`, `/slots/[slotId]`, `/plano-crescimento`, `/config` e
  `/mais` conduzem à Automação LIVE para bookmarks antigos.
- Navegação antiga de Slots/Plano/Mais e componentes/actions usados somente
  pelas telas manuais foram retirados. Os testes de UI exclusivamente manual
  também foram retirados; testes de migrations históricas foram mantidos sem
  exigir a interface descontinuada.

## Preservado

- Todas as migrations aplicadas, tabelas, RLS, ledger, fills, ganhos, ciclos,
  slots e eventos históricos, inclusive suas leituras e exportações.
- Relatórios históricos, baseline, `historico`, `ciclos` e `alertas` onde há
  necessidade de auditoria, sem reativar lançamento manual.
- Strategy Engine, ajustes/aportes da Automação, Testnet, recovery,
  idempotência, reconciliação, push e Capacity Manager.

Não execute scripts de seed ou `schema.sql` antigos para reconstruir Production.
Nova função deve partir de `AGENTS.md` e da Automação, não de páginas manuais
mantidas em commits históricos.
