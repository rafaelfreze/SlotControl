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

Para ambientes existentes, aplique as migrations em `supabase/migrations/` na ordem cronológica. O Plano de Crescimento Programado mantém os gains e o histórico financeiro intactos; seus aportes externos são registrados separadamente.

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
- Adicionar saldo
- Plano de Crescimento Programado com metas acumuladas, slot líder fechado e aporte externo auditável
- Taxa de gain configurável por estratégia, aplicada aos próximos gains e aos alvos ativos sem reescrever lucro histórico
- Preços de entrada e alvo arredondados; rankings separados de slots abertos e fechados por quantidade de gains
- Layout escuro mobile-first inspirado em ferramentas de trading
