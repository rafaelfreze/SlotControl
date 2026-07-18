# CoinOps Web

Aplicacao CoinOps criada com Next.js, Supabase Auth, Supabase Database e deploy preparado para Vercel.

## Rodar localmente

```bash
cd apps/web
npm install
npm run dev
```

Depois abra `http://localhost:3000`.

## Variaveis obrigatorias

Preencha em `apps/web/.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
CRON_SECRET=
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME="CoinOps"
```

No Supabase, execute `../../supabase/schema.sql` antes de testar cadastro e dashboard com dados.

## Supabase Auth

No painel do Supabase, configure as URLs de autenticacao:

- Site URL local: `http://localhost:3000`
- Redirect URL local: `http://localhost:3000/auth/callback`
- Redirect URL de producao: `https://SEU-DOMINIO.vercel.app/auth/callback`

O cadastro usa essa rota de callback para trocar o codigo de confirmacao por uma sessao valida antes de abrir o dashboard.

## Vercel

Configure o projeto da Vercel assim:

- Framework Preset: `Next.js`
- Root Directory: `apps/web`
- Install Command: `npm install`
- Build Command: `npm run build`
- Output Directory: deixe o padrao da Vercel para Next.js

No painel da Vercel, replique estas variaveis:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
CRON_SECRET=
NEXT_PUBLIC_SITE_URL=https://SEU-DOMINIO.vercel.app
NEXT_PUBLIC_APP_NAME="CoinOps"
```

`SUPABASE_SERVICE_ROLE_KEY` e `CRON_SECRET` sao variaveis exclusivamente server-side. O cron da Vercel usa `GET /api/cron/slot-automation` com o header `Authorization: Bearer CRON_SECRET` para processar entrada e saida automatica sem abrir ordens reais na Binance.

Depois do primeiro deploy, copie a URL final da Vercel e volte ao Supabase Auth para adicionar:

- Site URL de producao: `https://SEU-DOMINIO.vercel.app`
- Redirect URL de producao: `https://SEU-DOMINIO.vercel.app/auth/callback`

Antes de publicar, rode:

```bash
npm run predeploy
```
