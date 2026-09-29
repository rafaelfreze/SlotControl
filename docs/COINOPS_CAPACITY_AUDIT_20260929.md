# Capacidade: auditoria direcionada e contrato canônico — 29/09/2026

## Conclusão e evidência anterior à correção

Não existia teto de seis/sete motores. O bloqueio observado no Executor 02 era matematicamente esperado: `max(current, avg, peak15m) + reservas pendentes + 900 × novos motores <= 6000 × 0,65 = 3900`.
Com o pico informado de 4498: +1=5398 (89,97%), +2=6298 (104,97%). Nenhum cabia no teto de 3900. A reserva de recuperação é 2100 (35%), retirada uma única vez no teto; não é somada novamente à projeção. Não havia reservas pendentes na leitura oficial de 20:52Z.

Executor 01 já tinha os sete motores criados em 24–26/09, antes do registro/política às 18:43Z de 26/09. Eles não passaram pelo gate novo; os seis do 02 têm reservas de admissão registradas. Sete existentes não comprovam autorização histórica ou futura para sete sob qualquer carga. Ambas as configurações eram 6000/0,65/900.

| Leitura oficial, UTC | Shard | contas/motores | atual | média | pico15m | pressão conservadora | +1 | +2 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 20:51:42 | 01 | 4/7 | 2793 | 3394,47 | 4411 | 73,52% | 5311 / 88,52% | 6211 / 103,52% |
| 20:51:42 | 02 | 6/6 | 2102 | 2820,06 | 3812 | 63,53% | 4712 / 78,53% | 5612 / 93,53% |
| 21:07:42, ainda antes de qualquer alteração remota | 01 | 4/7 | 2789 | 2835,67 | 3029 | 50,48% | 3929 / 65,48% | 4829 / 80,48% |
| 21:07:42, ainda antes de qualquer alteração remota | 02 | 6/6 | 2038 | 2106,40 | 2210 | 36,83% | 3110 / 51,83% | 4010 / 66,83% |

Na primeira leitura: CPU 4,369%/2,452%; RSS 153,23/148,43 MB, RAM host 961,48 MB; backlog 0/0; reconciliação 25,842/26,918s; telemetria ~20s; erros/retries 0. Às 21:07: CPU 3,76%/2,579%, RSS 153,35/147,80 MB, reconciliação 26,437/26,007s. CPU/RAM não eram o limitador.

O pico caiu sozinho em uma janela completa. **Não foi liberado pela correção, por mudança de threshold ou por restart.** A política anterior já permitia o sétimo no 02 às 21:07Z, com 790 weight/min de folga adicional além da reserva de 2100. Ninguém cadastrou/ativou um motor nesta auditoria. Alvo de sete é compatível com essa projeção, não um mínimo garantido: o incremento 900 é fallback conservador não calibrado, e futuros mixes podem custar mais.

## Eficiência observada, sem consultas extras à Binance

Journal agregado por SSH, 20:39–20:54Z, somente chamadas normais já realizadas. Contagens comprovadas; atribuição exata de weight por motor não existe na telemetria atual. O header é cumulativo por IP e respostas concorrem: não usar diferenças de headers para inventar custo individual.

| Shard | Conta/mercado | snapshots completos / 15 min | queries de ordem / 15 min |
|---|---|---:|---:|
| 01 | Rafael BTCBRL | 139 | 42 |
| 01 | Rafael SOLBRL | 120 | 60 |
| 01 | Caixeta BTCBRL | 100 | 32 |
| 01 | Caixeta SOLBRL | 72 | 42 |
| 01 | Thyely BTCUSDT | 71 | 28 |
| 01 | Thyely SOLUSDT | 99 | 48 |
| 01 | Pedro SOLBRL | 99 | 48 |
| 02 | Diogo SOLBRL | 99 | 48 |
| 02 | Elizelena SOLBRL | 99 | 48 |
| 02 | Dete SOLBRL | 89 | 42 |
| 02 | Ricardo SOLBRL | 94 | 45 |
| 02 | Renato SOLBRL | 90 | 28 |
| 02 | Jenny Mae Maria SOLBRL | 94 | 30 |

Totais: 700 vs 565 snapshots, 427 vs 366 solicitações de health por motor (há cache de 20s, logo não são 427/366 consultas Binance), 15 coletas de capacity por shard. Nenhum READ_TRADES, READ_RECONCILIATION ou ACCOUNT_SNAPSHOT nessa janela. Watchdog saudável lê ledger/telemetria, sem Binance REST; capacity observa headers do tráfego existente e só faz probe público se o host estiver ocioso. Public market data usa `data-api.binance.vision`; não atribuir seu contador ao orçamento Production observado sem evidência do fornecedor.

O reconciliador lê estados frescos em estágios diferentes (antes/depois de proteção, crédito, configuração e entrada). Não foram eliminados nem cacheados nesta auditoria: fazê-lo genericamente compartilharia observações anteriores a fills/mutações. `safetySnapshot` já compartilha `getAccount()` com a validação de permissão na mesma chamada; ordens residentes inalteradas já evitam histórico de trades. Restam oportunidades de medição passiva de chamadas por rota/escopo; **não se comprovou um p95 marginal que autorize reduzir 900**, nem duplicação de reserva atual. Diferença de carga por engine e custo de health impedem extrapolar apenas contagem de contas ou BTC vs SOL.

## Bugs/lacunas corrigidos

1. ASSIGN tinha cutoff adicional de 50%, diferente da ativação. Com incremento 900, o efeito concreto era rejeitar o limite exato de pico=3000 (a ativação permitia 3000+900=3900). Não era a causa do caso 4498. Agora cadastro, preview e reserva usam `preview_executor_admission`.
2. O painel não explicava projeção, threshold e reserva; agora mostra +1/+2, fórmula, motivo exato e que 900 não é p95 medido. Não promete capacidade total 6/7 sem amostra marginal.
3. FLEET_PARITY era gate de publicação documentado, não pré-requisito persistido de admissão. Novos shards agora começam sem atestação; não podem admitir somente por terem peso baixo.
4. Defaults por shard podiam divergir. Trigger recusa perfil fora de `executor_capacity_policy()`. O bootstrap lê Node do manifesto comum, não mantém segunda versão fixa.

## Contrato e histerese

`coinops.executor_capacity_policy()` é a fonte de admissão. A função de preview é read-only e compartilhada com ASSIGN e reserva serializada (locks preservados). Classificação TypeScript dos cards tem teste de paridade contra a política SQL. REAL/Testnet mantêm orçamentos/reservas próprios; readiness do host usa identidade/runtime e telemetria Production pública como atestação de infraestrutura.

Condições de bloqueio: evidência >120s, registry incompatível, runtime/config/policy sem certificação, Watchdog ausente/stale, engine em recovery/blocked/stale, CPU>=70%, RAM>=75%, backlog, reconciliação>=120s, erros/retries recentes ou projeção acima de65%. Apenas novas admissões dependem disso. Nenhuma função nova toca trading.

Histerese conservadora já existente: máximo numa janela móvel de 15 minutos, sem latch em alertas. `TRANSIENT_SPIKE` significa pico anterior acima de atual/média; é classificação diagnóstica, não prova estatística de pico único. A reserva permanece até o pico expirar. `SUSTAINED_PRESSURE` exige média>=75%; `CAPACITY_LIMIT`, atual>=75%; `WARNING`, pressão>=65%. Em todos os casos o gate usa o maior valor da janela. Regressão prova a expiração real no coletor em 15min+1ms, sem restart. Alertas antigos não entram na fórmula.

## Novos shards e rollout

1. Registrar shard oficial com defaults e IP próprio, ainda sem contas; bootstrap herda o manifesto comum. Não copiar vaults/credenciais/IP de outro shard.
2. Publicar runtime comum com scripts oficiais, um host por vez se necessário. FLEET_PARITY comprova Git/bytes/processo/Node/serviço saudável. Não reiniciar para obter um PASS sem necessidade.
3. Aguardar >=2 amostras de minuto, registry consistente, collector e Watchdog recentes.
4. No control plane autorizado, com ambiente oficial e `COINOPS_FLEET_SSH_KEY` já configurados: `node apps/live-executor/deploy/capacity-preflight.mjs --verify`; então `--record`. Este último grava somente atestação, nunca admite conta/motor. RPC revalida todos os habilitados no momento da gravação. Nenhum secret em logs.
5. `executor_admission_readiness` verifica continuamente cada shard contra release/política certificadas e evidências locais. Readiness PASS não significa capacidade disponível: projeção continua dinâmica. Shard vizinho stale não invalida atestação válida do saudável.

Gates: EXECUTOR_CONFIG_PARITY, RUNTIME_PARITY, CAPACITY_POLICY_PARITY, TELEMETRY_ACTIVE, WATCHDOG_DISCOVERY, BINANCE_WEIGHT_TRACKING, ADMISSION_GATE_ACTIVE. Atestação segue válida para a identidade/release certificada; não substitui nova auditoria de bytes após deploy. Root externo pode contornar procedimentos, portanto não prometer infalibilidade.

Migration aditiva `20260929212150_coinops_canonical_admission_policy.sql`, schema coinops, funções de admissão SECURITY INVOKER e service-only; a função preexistente de reassignment conserva seu contrato restrito. Novas tabelas com RLS/FORCE RLS e zero grants anon/authenticated. Nenhuma credencial alterada, nenhum executor reiniciado, nenhuma mudança em Strategy Engine/reconciliação/ordens.

Rollback: restaurar bodies anteriores de preview/ASSIGN/reserve/reassignment via migration revisada, mantendo tabelas/evidência (não apagar). Web pode reverter ao SHA anterior; slots/ordens não precisam de rollback. Falha de certificação mantém novas admissões bloqueadas e trading existente operando.

## Validação/publicação

Migration aplicada no Supabase oficial às 21:21:50Z, sem tocar contas/motores/ordens. A versão local foi alinhada ao identificador retornado pelo serviço oficial. Às 21:22:16–21Z, nova verificação SSH comprovou FLEET_PARITY_PASS 2/2, Node v24.21.0, SHA comum `63273fe3e08e499fa5f753811a8fcc76cead8727`, 22 arquivos transitivos, fingerprint `f814f67154636ecfbb0acae17b6c1b3985158e93a5450b25453be50c2f651443`, bytes anteriores ao início dos processos. Não houve restart.

Certificação persistida: ADMISSION_PREFLIGHT_PASS. Readiness 2/2 sem falhas. Às 21:22:45Z: Executor 01, observado conservador 3443, +1=4343/6000 (72,38%), recusado; Executor 02, observado 2714, +1=3614/6000 (60,23%), permitido com 286 de folga além da reserva de 2100. +2=4514/6000 (75,23%), recusado. Nenhuma reserva ou ativação real foi solicitada.

Testes: 61 casos web/capacity (58 originais mais 3 regressões novas de ASSIGN no limite, REAL/Testnet e reservas simultâneas); 29 casos executor/fleet/deploy. PostgreSQL local descartável, sem skips. Lint, typecheck e build aprovados. Gates remotos: política/config/runtime, telemetria, Watchdog discovery e tracking Binance aprovados; RLS/FORCE RLS e ausência de grants anon/authenticated comprovados nas duas tabelas novas. Advisor de segurança anterior à migration: apenas diagnóstico dos objetos existentes, sem alterar outros produtos; tabelas administrativas service-only mantêm RLS sem policy pública deliberadamente.

Observabilidade de admissão é exportada no JSON administrativo autenticado de `/api/coinops-capacity` (decisão, motivo, política e fórmula) e nas atestações persistidas. Esta entrega não modifica semântica/formato dos relatórios financeiros v14 nem atribui decisões atuais a eventos financeiros históricos.

UI: quatro testes direcionados aprovados em Chromium e WebKit/iPhone emulado, larguras 320/360/375/390/430/1440, componente real com dados sintéticos e rede bloqueada. Fórmula, motivos +1/+2, reserva única, expansão e ausência de overflow verificados. Não equivale a teste em iPhone físico.

Publicação web: commit `f7462afc0b6bc32a4f989094965155b945cc83ed`, deploy automático `dpl_CX2sqEMfwXVWXoV6mydeKb9yQSVP`, READY, alias `https://cripto-flax.vercel.app`. Logs error/fatal dessa publicação consultados às 21:31:19Z sem ocorrências na janela. Consulta remota executada efetivamente como `service_role` aprovou o RPC; API anônima retornou 401 AUTH_REQUIRED com no-store. O navegador conectado não tinha sessão autenticada, portanto não se declara smoke visual logado em Production.

Após a migration: 21:27–28Z, Watchdog HEALTHY 2/2, motores ACTIVE 13/13, nenhum incident aberto/alerta crítico/kill switch. Ledger recém-reconciliado (24–38s): 23/23 posições OPEN com exatamente um TP residente próprio e 13/13 motores com exatamente uma NEXT BUY residente, ambas com exchange_order_id. Verificação persistida, não consulta adicional de histórico Binance. Runtime dos executores permanece acima; alteração exclusiva no control plane não exige rollout de processos LIVE.
