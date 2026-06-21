# SlotGain Control Web

Novo aplicativo SaaS do SlotGain Control, criado em paralelo a versao Google Sheets.

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
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME="SlotGain Control"
NEXT_PUBLIC_LEGACY_STORAGE_KEY=slotgain-control-state-v1
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
NEXT_PUBLIC_SITE_URL=https://SEU-DOMINIO.vercel.app
NEXT_PUBLIC_APP_NAME="SlotGain Control"
NEXT_PUBLIC_LEGACY_STORAGE_KEY=slotgain-control-state-v1
```

Depois do primeiro deploy, copie a URL final da Vercel e volte ao Supabase Auth para adicionar:

- Site URL de producao: `https://SEU-DOMINIO.vercel.app`
- Redirect URL de producao: `https://SEU-DOMINIO.vercel.app/auth/callback`

Antes de publicar, rode:

```bash
npm run predeploy
```
