# SlotGain Control

SlotGain Control e um SaaS simples para controle pessoal de operacoes cripto por slots. A versao atual usa Next.js, Supabase Auth, Supabase Database com RLS e deploy preparado para Vercel.

## Stack

- Next.js App Router
- React
- Supabase Auth
- Supabase Database
- Row Level Security
- Vercel
- PWA inicial

## Estrutura

```text
apps/web/              Aplicacao Next.js
supabase/schema.sql    Schema do banco, triggers e policies RLS
docs/                  Documentacao tecnica da migracao
.env.local.example     Exemplo de variaveis de ambiente
```

## Rodar localmente

```bash
cd apps/web
npm install
npm run dev
```

Abra `http://localhost:3000`.

## Variaveis de ambiente

Crie `apps/web/.env.local` com:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
CRON_SECRET=
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME="SlotGain Control"
```

O arquivo `.env.local` nao deve ser commitado.

## Banco Supabase

Execute o arquivo abaixo no SQL Editor do Supabase:

```text
supabase/schema.sql
```

Ele cria as tabelas, triggers, dados iniciais por usuario e policies de RLS. Cada usuario autenticado acessa apenas seus proprios dados.

Para ambientes existentes, aplique as migrations em `supabase/migrations/` na ordem cronológica. A Escada de Redistribuição BTC preserva valores, posições e histórico financeiro, separando permanentemente `real_gains`, `operational_gains`, aportes externos e redistribuições internas. Gains adicionados anteriores permanecem classificados como legado, sem reclassificação automática. A data inicial operacional é editável no Plano, independente da criação do usuário no Auth, e serve como fonte única dos ciclos de 30 dias exibidos também no Resumo.

A regra financeira oficial está em [`docs/ESCADA_REDISTRIBUICAO_BTC.md`](docs/ESCADA_REDISTRIBUICAO_BTC.md). Backtests e simuladores locais não são fonte de regra para o CoinOps real.

## Supabase Auth

Para desenvolvimento local, configure no painel do Supabase:

```text
Site URL: http://localhost:3000
Redirect URL: http://localhost:3000/auth/callback
```

Depois do deploy, adicione tambem:

```text
Site URL: https://SEU-DOMINIO.vercel.app
Redirect URL: https://SEU-DOMINIO.vercel.app/auth/callback
```

## Deploy na Vercel

Ao importar o repositorio na Vercel:

```text
Framework Preset: Next.js
Root Directory: apps/web
Install Command: npm install
Build Command: npm run build
```

Configure as variaveis na Vercel:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
CRON_SECRET=
NEXT_PUBLIC_SITE_URL=https://SEU-DOMINIO.vercel.app
NEXT_PUBLIC_APP_NAME="SlotGain Control"
```

`SUPABASE_SERVICE_ROLE_KEY` e `CRON_SECRET` são usados somente no backend. Nunca exponha essas variáveis no frontend. O cron remanescente atualiza somente a referência de mercado para a configuração manual de entradas.

## Validacao

```bash
cd apps/web
npm run test
npm run typecheck
npm run lint
npm run build
```

## Funcionalidades atuais

- Cadastro, login e logout com Supabase Auth
- Dashboard protegido
- Estrategias por usuario
- Slots por usuario
- Filtros por status
- Historico de acoes
- Plano BTC com meta mensal base de 7 gains como velocidade da escada, sem criar dívida acumulada para cada slot
- Referência assistida e editável, com prévia server-side antes de qualquer redistribuição financeira
- Ranking BTC por gains operacionais, incluindo slots abertos como doadores ou recebedores sem reescrever a posição executada
- Gains reais imutáveis, gains operacionais redistribuíveis e gains adicionados anteriores preservados como legado
- Ledger transacional para redistribuições internas e aportes externos, com conservação patrimonial e idempotência
- Taxa de gain configurável por estratégia, usada na unidade financeira `round((base + aporte) × taxa, 8)`; saldos de redistribuição permanecem contabilizados separadamente
- Preço de entrada identificado ao abrir o slot, sem exibição ou edição manual no card; rankings separados de slots abertos e fechados por quantidade de gains
- Layout escuro mobile-first inspirado em ferramentas de trading
