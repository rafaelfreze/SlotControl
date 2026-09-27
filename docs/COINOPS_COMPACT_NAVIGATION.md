# CoinOps — navegação e cards compactos

Alteração visual de 27/09/2026, sem alteração de trading, dados, Auth/RLS ou APIs.

## Automação ADMIN

- Navegação de ambientes mostra apenas **Testnet / Real**. Entrada sem filtro
  continua **Real**. Shadow e Overview não têm entrada de menu, mas código,
  histórico e URLs internas permanecem para diagnóstico autorizado.
- Barra principal: Início, Estratégia, Ajustes, Configurações e Custos & Operação.
  Operações, Relatórios e Simulador saem da navegação principal. Rotas de relatório
  e simuladores continuam internas; posições, alertas, TP/NEXT BUY e auditoria
  contextual não são apagados.
- Com conta **Todos**, as cotações por moeda vêm antes de Infraestrutura/Watchdog.
  No máximo quatro mercados únicos, sem repetir gráfico por nome da pessoa.
  Selecionar uma conta mantém seus próprios gráficos e detalhes isolados.

## Meu CoinOps — VIEWER

- Não existe ranking independente acima dos cards de mercado.
- Cada moeda tem os controles **Ver detalhes / Ver ranking** lado a lado,
  inicialmente recolhidos. No mesmo card, abrir um recolhe o outro.
- Ranking contém somente os slots daquele motor, com gains, contagem mensal e
  P&L líquido existentes. Mostra quinze slots inicialmente e permite abrir os
  restantes. Não muda cálculo financeiro nem mistura contas/mercados.
- Cada card controla seu próprio estado; botões expõem aria-expanded/controls,
  foco visível e altura mínima de toque de 44 px.
- Abrir/recolher não faz fetch, não atualiza saldo e não dispara ação operacional.

## Verificação

Regressões dirigidas em `premium-navigation.test.ts`, escopo Realtime e modelos
do VIEWER; specs visuais atualizados. Smoke interativo usa somente fixture
sintética ou navegação autenticada de leitura, nunca trades reais.

Checkpoint local: 10/10 testes dirigidos, lint sem avisos, typecheck e build
Next.js 14.2.35 aprovados. Smoke no Chrome com o componente real e dados
sintéticos em 320, 390 e 1440 px: botões lado a lado, toque de 44 px,
painéis inicialmente fechados, alternância detalhes/ranking, 15 + 10 slots,
estado independente BTC/SOL e ausência de overflow horizontal. A fixture não
usa Auth, exchange ou dados reais; não equivale a login VIEWER em Production.
