# SlotGain Control - Plano de Migracao para Supabase

Este documento registra a Etapa 1 da migracao do SlotGain Control para um SaaS simples com autenticacao, dados por usuario, Supabase e deploy na Vercel.

## Estado anterior preservado em historico

Antes da limpeza do repositorio, o projeto era uma aplicacao estatica composta por:

- `index.html`: estrutura da tela.
- `style.css`: visual responsivo, tema escuro e adaptacao mobile.
- `script.js`: estado, regras de negocio, renderizacao, localStorage, backup, CSV e sincronizacao online.
- `google-apps-script.gs`: backend antigo no Google Apps Script, usado para salvar/carregar um snapshot completo em Google Sheets.

O app usa a chave `slotgain-control-state-v1` no `localStorage`. Quando nao existe estado salvo, ele cria automaticamente:

- 25 slots de BTC 1%, valor base de 10 USDT, novo slot a cada queda de 2%.
- 10 slots de SOL 5%, valor base de 25 USDT, novo slot a cada queda de 12%.

O estado atual tem esta forma principal:

```json
{
  "version": 1,
  "createdAt": "ISO date",
  "updatedAt": "ISO date",
  "slots": [],
  "history": []
}
```

Cada slot guarda estrategia, numero, ordem manual, status, gains, valor base, taxa de gain, sinal de uso anterior, datas e observacoes. O historico registra acoes como abertura, gain, reset, edicao, saldo, redistribuicao, importacao e reset geral.

## Preservacao feita durante a migracao

Durante a migracao, a implementacao antiga foi copiada temporariamente para:

`legacy/google-sheets-v1/`

Depois que o SaaS Next.js/Supabase passou a ser a versao principal, os arquivos antigos foram removidos do repositorio para evitar confusao no GitHub e na Vercel. Este documento permanece apenas como registro tecnico da migracao.

## Modelo Supabase

As tabelas planejadas ficam em `supabase/schema.sql`.

Tabelas principais:

- `profiles`: perfil basico do usuario autenticado.
- `strategies`: estrategias do usuario, como BTC 1% e SOL 5%.
- `slots`: slots separados por usuario.
- `history_events`: historico separado por usuario.
- `user_settings`: configuracoes e preferencias separadas por usuario.

Tabelas auxiliares:

- `user_exports`: registro opcional de backups/exportacoes.
- `legacy_imports`: auditoria opcional de importacoes vindas do app antigo.

Todas as tabelas com dados do app usam RLS. A regra base e: o usuario autenticado so pode ler, criar, editar ou apagar linhas cujo `user_id` seja igual a `auth.uid()`.

O schema tambem prepara um gatilho de novo usuario. Quando alguem cria conta pelo Supabase Auth, ele cria automaticamente o perfil, as configuracoes iniciais, as estrategias BTC/SOL e os 35 slots padrao da versao atual.

## Etapas de migracao

1. Preservar a versao antiga durante a transicao, documentar arquitetura anterior, criar schema Supabase com RLS e preparar variaveis `.env.local`.
2. Criar um novo app Next.js em paralelo, com Supabase client, cadastro, login, logout e dashboard protegido.
3. Extrair a logica de slots para modulos reutilizaveis no novo app, mantendo calculos e regras atuais.
4. Persistir estrategias, slots, historico e configuracoes no Supabase por usuario.
5. Criar importador de backup JSON/localStorage para migrar dados existentes para o usuario logado.
6. Implementar backup/exportacao dos dados do usuario no novo app.
7. Transformar o app em PWA instalavel com manifest, icones e tema cripto.
8. Preparar deploy na Vercel, validar build e documentar variaveis de ambiente.

## Variaveis de ambiente

Use `.env.local.example` como base para o futuro `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME="SlotGain Control"
NEXT_PUBLIC_LEGACY_STORAGE_KEY=slotgain-control-state-v1
```

No app cliente, use apenas variaveis `NEXT_PUBLIC_*`. A `SUPABASE_SERVICE_ROLE_KEY` deve ficar restrita a rotinas server-side futuras.
