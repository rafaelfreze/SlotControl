# CoinOps / SlotControl — instruções do projeto

Estas regras valem para todo o repositório. Elas complementam as instruções globais carregadas pelo Codex e precisam continuar suficientes no Codex Cloud, que pode não receber configurações locais do computador do proprietário.

## Precedência e fonte de verdade

Quando houver conflito, aplicar nesta ordem:

1. segurança, integridade financeira e instrução explícita da tarefa atual;
2. documentação oficial atual;
3. arquitetura efetivamente usada pelo runtime e pela produção;
4. decisão mais recente comprovada pelo Git;
5. runbook atual;
6. instrução antiga ainda compatível;
7. hábito histórico.

GitHub e a branch oficial são a fonte do código. Backtests, snapshots, relatórios e READMEs anteriores à consolidação não vencem runtime, migrations ou runbooks atuais. READ-ONLY, NÃO IMPLEMENTAR AINDA e gates explícitos impedem qualquer mutação até nova autorização.

Descubra no Git, código, configuração e documentação tudo que for tecnicamente verificável antes de perguntar. Pergunte somente por decisão de negócio, credencial humana, alvo impossível de confirmar ou impacto materialmente irreversível.

## Identidade e limites oficiais

- Repositório: github.com/rafaelfreze/SlotControl; branch de produção: main.
- Monorepo: a aplicação Next.js fica em apps/web. Execute scripts Node nessa pasta; no Windows, prefira npm.cmd.
- Stack atual: Next.js 14.2.35, React 18, TypeScript, Supabase JS/SSR, npm e apps/web/package-lock.json. Node ainda não está declarado; não invente versão nem aplique regra do Next 16. Use a versão comprovada por Vercel/ambiente até uma tarefa específica declarar o runtime.
- Backend: OnPlay Platform otdfpmsegjxpqrzisfmi; schema operacional coinops.
- O cliente de dados e novas migrations CoinOps nunca apontam ao schema legado public. Dependências compartilhadas indispensáveis e já existentes podem permanecer em schemas de plataforma quando explícitas.
- Não há hard guard de project ref equivalente ao Fiscal. Antes de qualquer operação remota, confirme URL/ref/schema e pare se SUPABASE_DATA_SCHEMA não for coinops.
- Vercel: projeto cripto, ID prj_GNCqXG8MVG2ePgU3y6vuosz06GoR, root apps/web, domínio canônico https://cripto-flax.vercel.app.
- Resend e Mercado Pago não fazem parte da arquitetura atual. E-mails de Auth usam Supabase; SMTP/remetente live precisam ser reconfirmados antes de mudança.
- Não crie Supabase, Vercel, domínio ou integração substituta para contornar vínculo/configuração ausente.

Nunca misture schema, tenant, Auth, slots, ganhos, redistribuições, Vercel, secrets, dados ou regras deste produto com outro projeto.

## Ambiente de desenvolvimento e modelo

Desenvolvimento normal é Codex Cloud. Use o Cloud para código, migrations versionadas, testes, build, documentação, commit e push. Local é exceção somente quando o backtest/dataset físico realmente exigir, ou para Chrome autenticado/Computer Use local, Corel, LightBurn, impressão/hardware, arquivo físico exclusivo do PC ou recuperação excepcional. Não exija clone local nem sincronização/Apply Cloud -> Local por rotina.

Preferência do proprietário:

- trabalho diário: GPT-5.6 Sol com esforço Extra alto;
- arquitetura, migration/RLS crítica, segurança ou fluxo financeiro delicado: GPT-5.6 Sol com Ultra quando o controle da execução oferecer.

Texto neste arquivo não troca o modelo. Use somente o seletor/configuração suportado; se Ultra não estiver disponível, use o maior esforço suportado e registre a limitação.

## Autonomia e guardas de alto impacto

Uma tarefa de mudança autoriza, dentro do escopo, leitura, comandos, dependências determinísticas, edição, migration versionada, validação proporcional, correção diretamente relacionada, commit/push e um deploy final pelo fluxo Git quando a entrega o incluir. Não interrompa com confirmações repetitivas.

Sem autorização explícita da tarefa, pare antes de:

- registrar gain real/manual, aporte, débito, redistribuição, mudança de saldo ou movimentação de slot em produção;
- confirmar uma operação financeira preparada apenas como preview;
- efetuar pagamento, estorno, transferência, saque, compra, venda, trade ou ordem em exchange;
- apagar dados, executar DROP/TRUNCATE, migration destrutiva ou desfazer histórico;
- substituir/revogar secret, token ou credencial;
- alterar DNS/domínio, faturamento, cartão, Ads pagos ou comunicação em massa;
- force-push, reset destrutivo, excluir projeto ou descartar trabalho alheio.

Se a tarefa autorizar claramente uma operação de alto impacto, confirme por leitura tenant/escopo, entidade, valor, snapshot/hash, ambiente e limite; execute somente nesse limite, com confirmação prevista pelo produto, lock, idempotência, auditoria e evidência.

## Entrada, escopo e recuperação

Antes de editar:

1. execute git status, git diff, git diff --cached;
2. confirme HEAD, upstream, origin e commits recentes;
3. preserve arquivos modificados ou não rastreados que não pertençam à tarefa;
4. trabalhe a partir de apps/web para comandos Node;
5. leia somente módulo, dependências, testes, migrations e runbooks relacionados;
6. identifique Auth/RLS, tenant, dados financeiros, integrações e risco afetados;
7. formule o plano mínimo e corrija a causa raiz sem refatoração ampla.

Após interrupção, reconstrua o checkpoint com Git, arquivos novos, migrations locais/remotas e ações externas já concluídas. Reinício, 404 ou perda de interface não autoriza repetir webhook, deploy, migration, gain, redistribuição ou outra operação.

## Validação proporcional

- Tier 1 — pequena/documental: teste relacionado se existir; lint direcionado quando barato; typecheck quando aplicável; build somente se necessário.
- Tier 2 — pequena de código: testes relacionados, lint e typecheck; build conforme risco.
- Tier 3 — fluxo médio: testes relacionados, lint, typecheck e build; E2E/browser apenas no fluxo afetado quando útil.
- Tier 4 — financeira, migration/RLS/Auth estrutural ou grande: testes relacionados e suíte ampla justificada, lint, typecheck, build, E2E somente afetado e smoke não mutante após deploy quando necessário.

Não executar por rotina Playwright global, todos os viewports, Lighthouse, advisors completos, auditoria geral, builds repetidos ou testes não relacionados. Não repetir validação pesada aprovada no mesmo SHA sem mudança pertinente. Build não prova UI, mas navegador só é obrigatório quando o risco visual/interativo justificar.

O teste SQL financeiro deve usar banco efêmero/local explicitamente e rollback; nunca use o Supabase vinculado. Smokes não criam registro financeiro nem movimentam slots.

Preserve o harness Playwright, perfis e artefatos de falha existentes. Quando navegador for necessário, valide somente páginas/viewports afetados e inspecione Console/Network relevantes.

## Git, Vercel e custo

- Revise diff e migrations; stage apenas o escopo; nunca inclua .env, secret, node_modules, dataset, relatório grande ou screenshot sensível.
- Crie commit claro e focado e faça push pela branch apropriada quando a tarefa incluir entrega. main é produção, mas desenvolvimento não precisa ocorrer diretamente nela.
- Nunca force-push. Se o Cloud não puder fazer push, preserve commit/diff e use PR/Apply; Local continua exceção.
- Prefira a integração Git da Vercel. Um bloco lógico recebe no máximo um deploy final, salvo falha real.
- Consulte deployment uma vez no fechamento; logs somente em falha, smoke ou diagnóstico. Não faça polling.
- O cron market-regime roda a cada 5 minutos; preserve autenticação, lock, idempotência, timeout e custo antes de mudar a frequência.
- O install command versionado ainda usa npm install. Não o troque incidentalmente; em tarefa de setup, valide npm ci contra o lockfile antes da mudança.
- Não afirme READY, domínio, cron, log ou produção validados sem evidência real.

## Supabase, migrations e segurança

Antes de ação remota, registre explicitamente:

produto = CoinOps
project_ref = otdfpmsegjxpqrzisfmi
schema = coinops
ambiente = alvo confirmado
tenant/escopo = alvo confirmado
migration = nome, se houver

- Use migrations versionadas, aditivas e qualificadas em coinops. Confirme histórico/local-remoto e faça dry-run quando suportado.
- supabase/schema.sql e instruções para SUPABASE_DATA_SCHEMA=public são legado; nunca os execute como bootstrap atual.
- O bootstrap/criação inicial do schema não está versionado neste repositório. Não reconstrua a base por inferência; primeiro identifique e documente o proprietário oficial.
- A ausência de supabase/config.toml reduz a reprodutibilidade. Não compense apontando teste/local ao projeto remoto.
- Aplicação remota só ocorre se a tarefa incluir publicação, o alvo estiver inequívoco e os guardas financeiros forem satisfeitos.
- RLS é obrigatória em dados expostos/tenant. Autorizações e mutações continuam server-side; não confie em tenant_id, role, valor ou status enviados pelo cliente.
- service_role e secret keys são server-side. SECURITY DEFINER exige necessidade real, search_path seguro, validação interna de escopo e EXECUTE mínimo.
- Revise índices, constraints, FKs, concorrência, locks, idempotência, auditoria e rollback conforme o risco.
- Advisors e queries caras são diagnósticos dirigidos, não ritual.

Os exemplos de ambiente divergem: o exemplo raiz omite SUPABASE_DATA_SCHEMA e COINOPS_SERVICE_TENANT_ID; o exemplo do app ainda ensina public. Runtime/código e a identidade oficial acima vencem esses exemplos até sua correção em tarefa própria.

## Semântica financeira invariável

- real_gains, operational_gains, ganhos manuais, aportes, débitos, slots, saldos e redistribuições são conceitos distintos. Não renomeie, agregue ou converta sem compreender o contrato.
- Toda mutação financeira usa resolução server-side de escopo, validação de valor, snapshot/hash, preview quando previsto, confirmação explícita, lock, transação, idempotência e auditoria.
- Preserve histórico e trilha de origem; não sobrescreva resultado anterior para simplificar UI.
- Em timeout ou resposta incerta, consulte estado/idempotência antes de repetir.
- Nunca crie operação real para smoke, teste visual ou screenshot.
- Binance fornece somente market data e CoinGecko é fallback de preço. A arquitetura atual não envia ordens a exchange; não adicione execução de trade sem decisão de produto explícita e revisão separada.
- Notificações e PWA devem preservar escopo por usuário/tenant, action URL, sessão, safe-area e ausência de dados financeiros sensíveis em cache/log.

## Backtests e Local

- tools/backtests e datasets físicos são simulação isolada; não são fonte normativa para produção.
- Backtest local nunca usa Supabase remoto, Vercel, service_role ou credencial produtiva.
- Declare dataset, período, parâmetros, seed, fórmula e limitações; preserve reprodutibilidade.
- Resultado de simulação não altera slot, saldo, gain, regra operacional ou migration sem tarefa de produto própria.
- Arquivos não rastreados de backtest pertencem ao trabalho existente até prova em contrário; preserve-os e nunca faça stage por conveniência.

## Integrações, Chrome e observabilidade

- Use APIs oficiais, timeout, retry finito, backoff, cache, rate limit e idempotência.
- Não transforme Binance/CoinGecko em polling por render; o cron/job mantém checkpoint e dedupe.
- Não introduza Resend, Mercado Pago ou biblioteca cross-repo apenas porque são padrões de outros produtos.
- Chrome/Computer Use local está pré-autorizado quando a tarefa depende de sessão autenticada. Preserve perfil, extensão e Native Messaging; não limpe/reinstale por rotina.
- Nenhum clique em Gain, Open, confirmação de redistribuição ou outra ação financeira serve como smoke.
- Logs devem ser estruturados, sanitizados e sem token, secret, PII ou payload financeiro desnecessário. Não adicione plataforma paga sem lacuna comprovada.

## Variáveis — nomes, nunca valores

Descubra sempre o conjunto atual no runtime e nos exemplos. O inventário auditado inclui:

- Públicas/config de cliente: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_SITE_URL, NEXT_PUBLIC_APP_NAME.
- Config server-side: SUPABASE_DATA_SCHEMA, COINOPS_SERVICE_TENANT_ID.
- Secrets: SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET.
- Teste/build: PLAYWRIGHT_BASE_URL, NEXT_DIST_DIR, CI, NODE_ENV.

NEXT_PUBLIC_ é público e nunca recebe credencial. Nunca copie secret produtivo para arquivo local, Git, URL, log, screenshot ou relatório.

## Fechamento

Relate de forma proporcional:

- resultado e causa raiz;
- arquivos/dependências alterados;
- testes, lint, typecheck, build, E2E/smoke realmente executados;
- páginas/viewports e Console/Network efetivamente inspecionados, quando houver navegador;
- project ref, schema, tenant/escopo e migrations;
- qualquer operação financeira: preview, confirmação, idempotency key/hash e resultado, sem dados sensíveis;
- SHA, branch, push e deployment;
- limitações e pendências reais.

Nunca declare teste, migration, operação financeira, webhook, READY, smoke ou produção sem prova.
