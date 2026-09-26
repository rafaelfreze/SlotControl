# CoinOps Automation

CoinOps é uma plataforma Binance Spot de automação multi-conta. Production/LIVE
é o produto principal; Testnet é o ambiente de validação. ADMIN configura
contas, motores e estratégia pela Automação; VIEWER acompanha somente a conta
vinculada. O antigo controle manual de slots, operações e gains foi
descontinuado. Seu ledger, migrations e histórico permanecem para auditoria,
mas não são fluxos operacionais ativos.

## Código e implantação

- Fonte oficial: GitHub `main`.
- Web: `apps/web` (Next.js 14), Vercel `cripto`, domínio
  `https://cripto-flax.vercel.app`.
- Executor: `apps/live-executor`, VPS de IP fixo. Cada conta pertence a um
  único shard; falhas, locks e kill switches permanecem no menor escopo.
- Banco: Supabase OnPlay Platform, schema `coinops`; mudanças somente por
  migrations versionadas em `supabase/migrations`. Nunca execute o antigo
  `supabase/schema.sql` sobre um ambiente existente.
- Capacity Manager observa o executor server-side e bloqueia somente **novas
  ativações** sem telemetria recente ou headroom. Não interfere em ordens LIVE.

## Desenvolvimento local

Leia [AGENTS.md](AGENTS.md) antes de editar e use
[docs/INDICE.md](docs/INDICE.md) para os runbooks. A aplicação web usa os
scripts em `apps/web/package.json`; no Windows, use `npm.cmd`:

```text
cd apps/web
npm.cmd ci
npm.cmd test
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run build
```

Configure as variáveis apenas pelos exemplos e painéis oficiais, sem incluir
secrets no Git, frontend, documentação ou logs. A UI principal é
`/automacao?view=live`; Testnet e ferramentas administrativas ficam na
Automação. Relatórios e rotas de histórico preservados são somente leitura.

Veja [Capacity Manager](docs/COINOPS_CAPACITY_MANAGER.md) e
[auditoria de escala](docs/COINOPS_50_ACCOUNTS_AUDIT.md). Dados e migrations
históricos não devem ser apagados como parte da retirada da UI manual.
