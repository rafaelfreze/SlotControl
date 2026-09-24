# Automação premium — Fase 5.5

## Escopo e fronteira

Reconstrução visual de `/automacao` a partir da referência desktop/mobile fornecida pelo proprietário. Real, Visão Geral, Shadow e Testnet usam o mesmo shell e componentes. Esta fase não modifica Strategy Engine, executor, cron, decisões, ledger, migrations, RLS, Auth, adapters ou comportamento de ordens.

Backend oficial: OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`. A execução LIVE permanece server-side e independente da interface. Nenhuma ordem, cancelamento, reconciliação manual ou reinício deve ser usado como smoke visual.

## Componentes e paridade

- `premium-automation.tsx`: header/ambientes/toolbar, saúde, KPIs, BTC/SOL, posições/próximas BUYs/histórico/alertas, capital/limites/atividade/status.
- `premium-model.ts`: projeção somente leitura dos contratos atuais. Não produz decisões nem persiste dados. Mantém caixa lógico, saldo Binance, capital em posições e reservas separados; capital excedente da conta nunca vira cap.
- `premium-primitives.tsx`: ícones, moeda, formatação e drawer nativo com foco/Escape.
- `premium-controls.tsx` e `shadow-controls.tsx`: reutilizam formulários/actions e confirmações existentes; Testnet mantém gates e pausa indisponível; Real mantém preparação/dimensionamento/caps/dry-run.
- `premium-market.ts`: duas consultas públicas GET BRL para gráficos, cache de cinco minutos, timeout e fallback explícito. Não usa credencial. Curvas USDC nunca são rotuladas BRL.
- `premium-reference-ticker.tsx`: mantém uma única instância do ticker USDT existente (10s), separado dos preços/P&L BRL/USDC.

Os painéis ATH e de ajustes são movidos para drawers sem duplicação. A instância de ajustes permanece montada ao fechar/trocar o drawer: preview, confirmação pendente, resultado e idempotency key não são descartados. Simuladores ATH e ajustes A–J e Central de Relatórios continuam nas rotas existentes.

Slots têm uma lista compacta com filtros operacionais/físicos/gains/meta/elegibilidade/OPEN/espera. O drawer individual apresenta operação, rank/grupo, saldo, P&L, gains/meta, fees, ordens e IDs, eventos e evidência original. A análise completa preserva os painéis anteriores com histórico de ciclos, classificação temporal e controles detalhados.

## Semântica visível

- P&L realizado é acumulado, não "hoje"; ganhos manuais não são performance de mercado.
- Metas BTC/SOL são por slot, não metas agregadas do ativo.
- Uma ordem `PREPARED` não é residente. TP histórico preenchido não protege posição atual.
- Shadow usa TP/BUY virtuais; Testnet usa fundos fictícios; Real usa apenas posições próprias CoinOps.
- Ausência de evidência fica indisponível/atenção, nunca vira saldo ou saúde inventados.
- Saúde é informativa, derivada das evidências existentes; não aciona controles financeiros.
- O badge LIVE só fica verde com evidência operacional, não apenas um ciclo ACTIVE. Shadow respeita sua cadência de cinco minutos mais um minuto de tolerância visual; o cutoff LIVE permanece inalterado.
- Visão Geral agrega os três ambientes, mercado e atividades sem repetir o dashboard Real. Histórico ordena os dois ativos por timestamp antes de limitar a lista.
- Inputs numéricos Shadow recebem defaults numéricos (a vírgula localizada é reservada aos textos). Drawers bloqueiam o scroll de fundo e restauram o estado ao fechar.
- O monitor 6h é a agenda já versionada, não uma alegação de execução verificada pela UI.

## Validação reproduzível

Na pasta `apps/web`:

```powershell
node --experimental-strip-types --test app/automacao/premium-model.test.ts lib/slotgain/premium-controls-contract.test.ts lib/slotgain/monthly-slot*.test.ts lib/slotgain/testnet-results.test.ts
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:9'
npm.cmd run test:e2e -- tests/e2e/automation-premium.spec.ts --project=desktop-chromium --workers=1
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```

O harness renderiza componentes e CSS reais com fixtures sintéticas, bloqueia rede/submissões/actions e não requer credenciais. Cobre quatro ambientes, 360/390/430/1024/1280/1440/1920, oito screenshots desktop/mobile, slots/drawers, teclado e persistência de draft. Capturas ficam em `test-results/`, ignorado no Git. Fixture não prova conta Production: o fechamento inclui smoke autenticado Chrome e consultas GET independentes pelo executor.

Baseline operacional consultado antes do redesign: BTC e SOL ACTIVE, cada um com 25 slots, 2 OPEN, 2 TPs residentes, 1 NEXT BUY e 22 PLANNED; sem alerta ativo. Os níveis variam naturalmente se o robô preencher ordens durante o trabalho. Comparar novamente após publicação, sem cancelar/criar ordens para forçar igualdade.

## Rollback

Reverter somente o commit de UI pelo fluxo Git normal. Não reiniciar executor, alterar flags LIVE, cancelar ordens ou reverter ledger. Nenhuma migration foi introduzida por esta fase.

## Workspace e navegação global — complemento visual pós-5.6

`/automacao` ocupa a largura disponível, sem o antigo limite central de 1320px. Em desktop, as margens laterais variam de 16 a 24px; grids mantêm suas proporções e tipografia. Em mobile, o shell mantém 14px e respeita os safe-area insets. As mudanças são locais a `.px-app`: o layout de `/dashboard` não é alterado.

`premium-global-navigation.tsx` acrescenta um disclosure junto à marca, com os destinos reais Automação, Resumo, Slots, Plano, Histórico, Relatórios, Ciclos, Alertas e Configurações. Os nove links não disparam prefetch. O menu abre no fluxo do documento, sem sidebar fixa nem overlay sobre os cards. Tem alvos mínimos de 44px, `aria-expanded`, fechamento por Escape com retorno do foco, clique fora e saída de foco. O menu da conta/onboarding continua separado. A marca aponta a `/automacao`; Resumo permanece `/dashboard`.

As duas barras internas — ambientes e ferramentas — continuam presentes e independentes desse menu. A barra de ferramentas conserva seu scroll horizontal próprio no celular; a página não deve produzir overflow horizontal.

O harness offline agora cobre 24 casos: as quatro views, isolamento A/B, drawers e controles anteriores, mais sete casos de workspace/menu em 360, 390, 430, 1024, 1280, 1440 e 1920px. Cada novo caso confere margens, rotas existentes, touch targets, teclado, fechamento, não sobreposição e screenshots aberto/fechado. Rede, submissões e actions permanecem bloqueadas; screenshots não contêm dados produtivos. A emulação de largura não equivale a uma validação física de iPhone/PWA nem prova insets não nulos de um aparelho.
