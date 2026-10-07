# CoinOps / SlotControl — instruções do projeto

Estas regras valem para todo o repositório. Elas complementam as instruções globais carregadas pelo Codex e precisam continuar suficientes no Codex Desktop Local e também em execuções Cloud solicitadas explicitamente.

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

- Testnet operacional foi descontinuada em 30/09/2026 por decisão do proprietário. O menu, onboarding, controles, diagnóstico e cron Testnet ficam desativados pela política versionada `testnet-policy.ts`, mesmo com uma variável de ambiente antiga habilitada. Links antigos redirecionam para REAL sem executar ações. Preservar ledgers, relatórios e testes offline históricos; não reativar Testnet incidentalmente. Production/LIVE não muda. Ver `docs/COINOPS_TESTNET_RETIREMENT.md`.

- Repositório: github.com/rafaelfreze/SlotControl; branch de produção: main.
- CoinOps é uma plataforma de automação Binance multi-conta. Production/LIVE é o produto operacional; Testnet é somente histórico desde 30/09/2026. Painéis ativos: ADMIN da Automação e VIEWER de cada conta. O modelo manual anterior está descontinuado e não orienta arquitetura, navegação, novas features ou testes. Histórico financeiro e compatibilidade de leitura permanecem preservados.
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

Desenvolvimento normal ocorre nos checkouts oficiais locais do PC principal e do notebook, com o Codex Desktop em modo Local, para código, migrations versionadas, testes, build, documentação, commit e push pelo fluxo Git oficial. Cada checkout Local pode usar suas próprias dependências, runtime, worktrees e datasets necessários, preservando o isolamento de backtests. O GitHub/main é o único meio de sincronizar código entre computadores: não use OneDrive, cópia direta de arquivos ou espelhamento do checkout. Antes de alinhar main em outro computador, preserve commits e alterações locais legítimas em uma branch/checkpoint recuperável, sem incluir secrets, caches ou artefatos, e nunca sobrescreva trabalho existente. O TeamViewer continua sendo o acesso remoto principal ao PC da loja. Codex Cloud e Codex Remote são opcionais e só devem ser usados quando o usuário os solicitar explicitamente. Task Cloud, URL Cloud e Apply não são requisitos; quando o Cloud for solicitado, qualquer Apply só pode ocorrer após validar task, repositório, branch/HEAD, diff e estado Local, nunca automaticamente.

Preferência do proprietário:

- preferência: GPT-6 Astra com esforço Ultra;
- fallback: GPT-5.6 Sol com o maior esforço suportado quando o modelo preferencial não estiver disponível.

Texto neste arquivo não troca o modelo. Use somente o seletor/configuração suportado; se Ultra não estiver disponível, use o maior esforço suportado e registre a limitação.

## Autonomia e guardas de alto impacto

Uma tarefa de mudança autoriza, dentro do escopo, leitura, comandos, dependências determinísticas, edição, migration versionada, validação proporcional, correção diretamente relacionada, commit/push e um deploy final pelo fluxo Git quando a entrega o incluir. Não interrompa com confirmações repetitivas.

Sem autorização explícita da tarefa, pare antes de:

- registrar gain, aporte, débito, redistribuição ou mudança de saldo em produção fora dos fluxos administrativos atuais da Automação;
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
- Nunca force-push. Se o push não puder ser concluído, preserve commit/diff, reporte o bloqueio e use o fluxo Git/PR suportado e apropriado.
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

Os exemplos de ambiente usam `SUPABASE_DATA_SCHEMA=coinops`; nunca troque para
`public` por instrução histórica. Confirme o project ref e o tenant de serviço
no ambiente de destino antes de operação remota.

## Semântica financeira invariável

- Tabelas de ganhos manuais, aportes, débitos e redistribuições legadas são histórico/compatibilidade, não autorização para recriar operação manual. Preserve seus significados e dados para auditoria; ajustes/aportes administrativos atuais da Automação continuam válidos.
- Toda mutação financeira usa resolução server-side de escopo, validação de valor, snapshot/hash, preview quando previsto, confirmação explícita, lock, transação, idempotência e auditoria.
- Preserve histórico e trilha de origem; não sobrescreva resultado anterior para simplificar UI.
- Em timeout ou resposta incerta, consulte estado/idempotência antes de repetir.
- Nunca crie operação real para smoke, teste visual ou screenshot.
- O CoinOps REAL atual envia ordens Spot pela Strategy Engine, ledger e executor de IP fixo. Nenhum smoke ou teste cria ordem real; toda alteração nesse caminho exige reconciliação, proteção de TP, escopo e idempotência. Dados públicos de mercado e backtests não autorizam execução.
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

## Multi-account, isolamento e capacidade

- Saldo Spot físico fresco deve financiar novas BUY; capital lógico/Earn não
  substitui caixa. Falta de saldo aguarda reposição sem redimensionar estratégia
  nem interromper TP/fills. Claim ambíguo nunca é apagado para repetir ordem.
  Recuperação de rejeição pré-POST exige prova assinada e lease; compatibilidade
  histórica restrita: `docs/COINOPS_QUOTE_BALANCE_RECOVERY_20261007.md`.

- Watchdog operacional é server-side: crons Vercel, telemetria dos executores e reconciliação LIVE. Navegador, PC e Codex não são componentes do laço 24/7. A checagem rápida usa dados internos; Binance REST e qualquer correção de ordem passam somente pelo reconciliador com lease/idempotência por motor. Condição ambígua permanece `BLOCKED_SAFE` no menor escopo, com incidente persistido e push. Consulte `docs/COINOPS_SERVER_WATCHDOG.md`; não aumente o polling Binance para satisfazer um indicador visual.

- O CoinOps é multi-account. Toda ação deve carregar explicitamente `operator_id`, `exchange_account_id`, `trading_engine_id`, ambiente e símbolo ao atravessar account → engine → job → lease/lock → reconciliação → alerta → kill switch. Falha local bloqueia somente o engine afetado; kill switch global exige causa sistêmica comprovada.
- Norma autorizada em 04/10/2026: a conta pode possuir N motores, inclusive do mesmo símbolo, em N executores. O `trading_engine_id` pertence a exatamente um shard imutável; a conta não fica presa ao shard. Novos motores podem usar outro executor certificado sem mover os existentes. O campo antigo `exchange_accounts.executor_shard_id` é compatibilidade/bootstrap, nunca autoridade de roteamento de um motor. A implementação e os gates ainda precisam de prova antes da liberação; consultar `docs/COINOPS_MULTI_ENGINE_MULTI_SHARD.md`. Não rotacione IP para contornar rate limit Binance nem rebalanceie LIVE automaticamente.
- Capacidade é medida, não deduzida do número de usuários. Antes de admitir nova carga, exigir telemetria fresca do shard, custo incremental conservador e headroom para recovery: peso Binance/IP, CPU, RAM, backlog, reconciliação, heartbeat e retries. Se a evidência estiver ausente, a decisão é `CAPACITY_UNKNOWN`, nunca um SIM inventado.
- Planeje SCALE_OUT/novo IP antes da saturação de peso Binance; SCALE_UP somente se CPU/RAM forem o gargalo medido. Nenhuma conta pode consumir o headroom de recuperação das demais. Não crie VPS/IP/recurso cobrável sem autorização.
- O modelo de decisão fica em `apps/web/lib/coinops-capacity/capacity-manager.ts`. O gate de admissão somente é considerado ativo após migration, coleta contínua, publicação do executor e web, e smoke comprovados. Motores existentes não dependem do Capacity Manager para operar; indisponibilidade dele bloqueia apenas novas ativações.
- Admissão canônica: `coinops.executor_capacity_policy()` e `preview_executor_admission` são a única fórmula usada pelo preview, ASSIGN e reserva serializada. `capacity-manager.ts` classifica saúde/pressão; regressão SQL exige paridade dos thresholds. Perfil comum: 6000/min, projeção <=65%, reserva única de 35%, incremento conservador de 900 (não chamar de p95 medido). Política v3: média dos máximos por minuto em 15 min, pelo menos 15 amostras; pico histórico somente OBSERVE, que pode coexistir com SIM. Histerese persistida pelo coletor por shard/ambiente/+N: reabrir após 10 min contínuos com projeção <=60%; bloquear quando média projetada >65%, atual >=75% ou atual projetado >=90%, preservando gates de freshness/recursos/Watchdog. GET/reload nunca avança o relógio. Não há cota de sete motores. Ver `docs/COINOPS_ADMISSION_HYSTERESIS_20260930.md`.
- Todo novo shard herda defaults da política, Node/release do `fleet-release.json`, e permanece sem admissão até `capacity-preflight.mjs --record` no control plane autorizado. A certificação exige FLEET_PARITY_PASS de todos os habilitados; SQL revalida política, runtime da telemetria, IP, registry e Watchdog por shard. Falha só bloqueia novas admissões; não pausa motores. Reexecutar após mudança de runtime/política/IP e antes de onboarding. Ver `docs/COINOPS_CAPACITY_AUDIT_20260929.md`.

### Contrato multi-shard e onboarding

- Roteamento canônico: `operator_id + exchange_account_id + trading_engine_id + environment + executor_shard_id`, resolvido no backend pelo motor. Símbolo, posição visual e bootstrap da conta não identificam um motor. Um engine desconhecido nunca cai no Executor 01. O backfill mantém cada motor no executor onde já opera; alterações posteriores do shard do engine são proibidas. O antigo RPC de reatribuição staged não autoriza mover motores sob este contrato: sua compatibilidade deve ser revisada/guardada antes da nova release.
- Cada vínculo conta/executor exige validação própria de credencial e whitelist no IP correto, mantendo todos os IPs anteriores. A identidade física Binance permanece única por conta/operador, não por shard; uma chave nova não transfere ownership. Não copiar vault, private keys, credenciais Binance ou estado entre executores. Credencial de outro shard é inserida pelo proprietário via painel/HTTPS e armazenada apenas no vault daquele shard; nenhum secret retorna ao browser.
- Binance request weight é por IP; `ORDERS` e filtros de conta são compartilhados entre chaves/IPs. Admissão e dispatch multi-shard exigem amostra assinada recente, inventário completo e reserva serializada por conta, sem reset presumido, bypass, quota fixa de motores ou polling por render. Conservar orçamento para proteção/recovery. Motores do mesmo par exigem STP maker-preserving (`EXPIRE_TAKER`) em todos os transportes envolvidos: nunca usar EXPIRE_MAKER/BOTH para cancelar ordens de outro engine. Suporte publicado pela Binance, sozinho, não prova enforcement.
- Ownership de BUY/TP/NEXT BUY/fill/cancel/recovery exige namespace determinístico do engine e identidade exata de ordem. `CANCELED`, account+symbol, orderId avulso ou flag do caller nunca são prova de ownership. Locks/leases/run/ledger/slots/strategy/ATH/meta/cap/recovery são por engine. Watchdog e falhas são do engine/shard afetado, nunca dos irmãos por compartilharem conta/símbolo.
- Account UUID e identidade física Binance são fronteiras distintas: a mesma identidade Binance não pode ganhar outro dono em outro shard. Claims de identidade ficam server-side, sem UID/secret no frontend; falha de claim impede nova ativação.
- Cadastro: ASSIGN por capacidade fresca → exibir executor/IP → whitelist e credential → Preview → gate final serializado → Activate. Atribuição não reserva capacidade indefinidamente. Revalidar no último instante; não mover contas existentes nem desligar um motor para abrir espaço.
- Filas concorrentes LIVE e Testnet são limitadas e independentes por shard. Locks/idempotência financeiros continuam por engine/run. Falha de transporte ou deploy de um shard não deve monopolizar a fila do outro.
- Configuração web multi-shard é server-only (`COINOPS_EXECUTOR_SHARDS_JSON`); cada entrada tem IP/base/HMAC exclusivos. Executor usa `COINOPS_EXECUTOR_SHARD_ID` e rejeita envelope de shard divergente antes de acessar vault/exchange. Não copiar credenciais, locks ou estado do Executor 01 para um novo executor.
- Novo shard pode usar `COINOPS_EXECUTOR_XX_CONFIG_JSON` server-only dedicado para preservar um JSON `sensitive` existente sem decrypt/substituição. Não sobrescreve IDs já configurados; exige IP/HMAC exclusivos e os mesmos gates canônicos. Nunca tornar secrets recuperáveis para facilitar scale-out. Ver runbook de shard.
- Peso Binance é orçamento de cada IP, jamais soma de orçamentos de IPs diferentes. Shard vazio coleta evidência pública limitada; ausência de métrica não é peso zero nem capacidade disponível. Alertas incluem shard e contexto de conta/engine quando aplicável; ausência de telemetria não resolve incidentes anteriores.
- Production e Testnet possuem evidência de request weight separada por host. Production mantém sua tabela de capacidade; Testnet usa amostra por ambiente e inventário de contas autorizadas no vault combinado com engines do ledger. Ausência desse payload em executores antigos bloqueia apenas nova admissão Testnet, nunca sua execução existente. Não atribuir peso fictício Testnet ao budget Production.
- Deploy/rollback de novo executor usa GitHub/main + SHA completo, release imutável, health exato e estado persistente separado. Não dependa de checkout ou arquivo particular de PC/notebook. Nunca reinicie o Executor 01 para testar o Executor 02.
- Deploy e rollback de qualquer executor exigem leitura/import do código como `User`/`Group` reais do systemd antes de restart, não apenas como root. Código público usa `umask 022`; env/vault/estado mantêm permissões privadas. Usar `deploy-legacy.sh` somente no checkout estabelecido do Executor 01 e `deploy-shard.sh` nos demais; ambos usam `runtime-preflight.sh`. Incidente EACCES causado por root/umask077 nesta manutenção e procedimento seguro: `docs/COINOPS_SHARD_DEPLOY_RUNBOOK.md`.
- Não declarar a infraestrutura ativa com base apenas no código: conservar gates, SHA, IP, health, migrations, smoke e limitações no runbook/relatório da entrega. Teste de fixture não comprova uma ordem Binance Testnet real nem entrega física de push.

### Paridade obrigatória dos executores

- Regras, runtime e contrato financeiros são comuns a todos os shards, atuais e futuros. IP, HMAC, vault, contas e limites por conta permanecem isolados: paridade nunca significa copiar configuração privada ou capital.
- A release comum revisada está em `apps/live-executor/deploy/fleet-release.json`. Alteração de runtime exige publicação sequencial para TODOS os shards habilitados descobertos no registry oficial, seguida de `fleet-parity.mjs --check-code` e `--verify`. Um health individual ou SHA declarado não basta: conferir código público por fingerprint, processo, Node, identidade/IP e freshness. Nunca encerrar rollout sem `FLEET_PARITY_PASS`.
- Novos shards usam a mesma release e entram na verificação automaticamente. Bootstrap/DEPLOY_HEALTHY individual não significa pronto para onboarding. Diferença durante janela rolling autorizada é transitória, não PASS final. Divergência de paridade não autoriza kill global, restart automático, troca de credenciais, migração de contas ou ordem corretiva.
- Mudança exclusivamente web que não altera o grafo de runtime do executor não exige restart de VPS. A Strategy Engine/reconciliação server-side é compartilhada, não copiada como regra particular de uma conta. Procedimento e evidência: `docs/COINOPS_EXECUTOR_FLEET_PARITY.md`.

## Custos & Operação (FinOps ADMIN)

- Redução de custo comprovada em 05/10/2026: watchdog/LIVE/Capacity/push continuam
  a cada minuto. Não recriar supervisão Codex de 2h: a automação existente usa
  auditoria diária. Alertas de capacidade saudáveis não fazem UPDATE vazio;
  transições reais permanecem imediatas. Logs LIVE saudáveis são sumários amostrados,
  nunca substituem o ledger; falha/retry/recovery e transição não são amostrados.
  Custos faturados, incluídos e projetados permanecem separados. Ver
  `docs/COINOPS_VERCEL_COST_AUDIT_20261005.md`.

- `/custos-operacao` é exclusivamente ADMIN; VIEWER não acessa custos internos nem APIs FinOps. Tabelas `coinops.finops_*` são server-only, com RLS e escopo tenant/operator.
- Capital Binance e P&L de estratégias nunca são receita da plataforma. Custos seguem `REAL > ESTIMADO > RATEIO_ESTIMADO > INDISPONIVEL`; `MANUAL` identifica entrada/evidência, não cobrança confirmada. Sem fatura não significa custo zero.
- A tela lê snapshots persistidos; coleta agendada independente a cada seis horas e atualização operacional sob demanda. Não acoplar billing, câmbio ou FinOps a trading, watchdog, admissão ou reconciliação com escrita. Falha de billing não bloqueia nenhum motor.
- Cron FinOps autenticado usa uma coleta por janela UTC de seis horas (`17 */6 * * *`), sob lease/fencing; fornecedores no ADMIN mantêm cooldown móvel de seis horas. O botão Atualizar dados pode atualizar capital e telemetria separadamente, com snapshot read-only pelos executores e cooldown operacional persistido de 60s; nunca reaplicar o cooldown de billing ao capital. Preservar datas de cada fonte e distinguir coleta parcial. Somente `syncAllFinops` habilita o modo interno `SCHEDULED`: nunca aceitar esse modo/force do browser. Coleta operacional, ajuste manual sem coleta externa e reparo FX não alteram o relógio dos fornecedores.
- Preservar moeda original, fonte/data, método de rateio, período do fornecedor e câmbio congelado em cada snapshot. USD não equivale a USDT. Tarifas documentadas são estimativas, nunca valores pagos.
- Registry descobre executores automaticamente; preço de um novo recurso precisa de evidência/configuração, não herda US$6 cegamente. Regras e limites: `docs/COINOPS_FINOPS_PROVIDERS.md`.

## Variáveis — nomes, nunca valores

Descubra sempre o conjunto atual no runtime e nos exemplos. O inventário auditado inclui:

- Públicas/config de cliente: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_SITE_URL, NEXT_PUBLIC_APP_NAME.
- Config server-side: SUPABASE_DATA_SCHEMA, COINOPS_SERVICE_TENANT_ID.
- Secrets: SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET.
- Billing opcional server-side: FINOPS_DIGITALOCEAN_TOKEN (inventário de recursos, leitura), FINOPS_VERCEL_TOKEN (billing, leitura). Sem credencial, preservar preço/rateio documentado e identificar a origem; não inventar sincronização de fatura.
- Teste/build: PLAYWRIGHT_BASE_URL, NEXT_DIST_DIR, CI, NODE_ENV.

NEXT_PUBLIC_ é público e nunca recebe credencial. Nunca copie secret produtivo para arquivo local, Git, URL, log, screenshot ou relatório.

## Contrato obrigatório de auditoria e relatórios

Toda nova regra operacional, estado de slot, tipo de ordem, mecanismo de execução, regime, meta, aporte, reciclagem, proteção ou comportamento que possa alterar decisões do robô deve ser incorporado à camada de auditoria/relatórios na mesma entrega, com testes correspondentes. Nova regra sem observabilidade/exportação = tarefa incompleta.

- Central: `/relatorios`; exports autenticados em `/api/coinops-reports`, sempre no escopo de produto, tenant e usuário com RLS.
- Contrato versionado: `apps/web/lib/coinops-reports`, `report_version = 19`, com roteamento e metadados de isolamento por engine/shard e evidência de atribuição/retry do trading. Declaração de identidade não substitui certificação de runtime, credencial e capacidade; ausência de evidência não é READY. Ao mudar semântica ou formato, versionar e atualizar fontes, regras, checks, CSV/JSON, documentação e testes juntos.
- Aporte aplicado ao slot da NEXT BUY: o reconciliador oficial pode atualizar quantidade no mesmo preço somente após prova de aporte, BUY sem fills, caps sincronizados e suporte `ONLY_NEW`. OPEN/TP nunca são ampliados; fill concorrente vence a substituição. Ver `docs/COINOPS_NEXT_BUY_CAPITAL_REFRESH.md`. Não usar cancelamento manual, MARKET complementar ou outra implementação de estratégia.
- Preservar identidade física de slots, histórico imutável, separação SHADOW/TESTNET/REAL e origem da evidência. Lacunas históricas, snapshots atuais e ambiguidades devem ser explícitos; não transformar ausência de evidência em PASS ou zero.
- Relatório é somente leitura. Nunca iniciar execução, reconciliação com escrita em exchange ou operação financeira para gerar relatório/smoke.
- Persistência UTC; apresentação auditável em `America/Campo_Grande`; exportação sem secrets. Consulte `docs/COINOPS_REPORTS_V1.md`.

## Saúde do Ativo — fronteira obrigatória

- `apps/web/lib/coinops-asset-health` é informativo e read-only em relação ao trading. BTC/SOL usam fontes públicas, coleta server-side, snapshots e regras determinísticas. Ver `docs/COINOPS_ASSET_HEALTH.md` e `docs/COINOPS_ASSET_HEALTH_SOURCES.md`.
- `BINANCE_HEALTH_CANNOT_TRADE`: Saúde da Binance usa o mesmo pipeline de snapshots/eventos, probes públicos e telemetria por shard. Falha de um executor/IP/key não é falha global Binance. PoR sem feed verificável é dado indisponível, nunca solvência presumida. Não importar cliente de ordens/saques/transferências nem acoplar status a trading.
- `STRUCTURAL_RISK` nunca significa SELL ALL, PAUSE, cancelar ordens, mudar estratégia, slots, ciclos, ATH, spacing, TP, NEXT BUY, kill switch ou Capacity Manager. Qualquer acoplamento futuro exige nova decisão arquitetural explícita do usuário.
- Watchdog observa somente execução/freshness/falhas do coletor; saúde estrutural não entra na saúde ou recuperação dos motores. Alertas usam outbox separada e ADMIN, nunca `robot_v1_live_alerts`.
- GET lê snapshots persistidos; não coleta fontes nem prolonga validade ou promove status. Sem evidência recente: DADOS INSUFICIENTES, nunca falso verde/vermelho. Preço não é sinal de risco estrutural.
- Testes direcionados: `npm run test:asset-health`; SQL concorrência/RLS local: `npm run test:asset-health:sql` (PostgreSQL local descartável, nunca Production). Histórico começa na implantação, sem preencher datas passadas artificialmente.

## Entrega e fechamento

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
