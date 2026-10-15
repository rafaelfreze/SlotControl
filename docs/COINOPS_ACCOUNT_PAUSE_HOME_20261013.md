# Pausar novas compras e ocultar uma conta da Home

## Contrato

O ADMIN seleciona uma conta em `/automacao` e confirma **Pausar novas compras e ocultar da tela inicial**. O controle atua em todos os motores REAL operacionais daquela conta, sequencialmente, inclusive motores do mesmo símbolo em shards diferentes. Não altera a estratégia, gain, spacing, meta, capital, slots físicos ou ownership. Não vende posições.

A pausa usa `pauseLiveRun`, lease e reconciliador oficiais. Fecha os gates de BUY do motor/preparação, cancela somente a entrada própria cuja identidade e estado foram comprovados e reconcilia a resposta. Fill concorrente vence o cancelamento: passa pelo fluxo normal de proteção por TP. Resposta ambígua continua fail-closed somente no motor; não há retry automático do comando financeiro. O engine permanece ACTIVE no registry para continuar descoberto pelo worker, com run PAUSED e gates de novas compras fechados.

### Posições antigas continuam

O worker PAUSED segue reconciliando ordens/fills, assegurando TPs e creditando gain exatamente uma vez pelo mesmo ledger. Após esses passos, valida proteção/ownership/caps e conclui `RECONCILED` com `next=ENTRIES_PAUSED`. Não recicla slot CLOSED, decide reentrada, modifica ATH ou cria successor/reset durante a pausa. Fechar o último TP não pode causar RESET_GATE_FAILED nem abrir um novo ciclo. Retomada exige ação explícita pelo fluxo oficial de Estratégia e motores ou pelo botão **Reativar operação e reexibir na tela inicial** na conta.

### Retomada explícita e reexibição (15/10/2026)

O novo botão confirma a operação REAL, consulta inventário fresco da conta e envia `RESUME` sequencial somente para os engines PAUSED em `/api/coinops-engine-control`. Reutiliza `resumeLiveRun`: lease, ownership engine/account/shard, reconciliação recente, ledger/TPs completos, caps, BNB/Spot por ordem e CAS dos gates. Não usa ACTIVATE, não recria o run, não altera estratégia e não desfaz motores já retomados em caso de falha parcial. Resposta incerta exige readback; nenhum POST financeiro é repetido automaticamente. A confirmação exige `RESUMED` e o mesmo run; a leitura final confere inventário, run ACTIVE e gates de entrada abertos antes do SHOW. Reexibir sozinho permanece exclusivamente visual.

O comando administrativo não interativo `/api/cron/live-control` aceita PAUSED ou ACTIVE exclusivamente em RESUME, com health ACTIVE/PROTECTED, como a rotina canônica. PREPARE continua exigindo READY; ACTIVATE continua exigindo PREPARING/ACTIVE-health e admissão. Segredo dedicado, host Production, schema e escopo existentes permanecem obrigatórios. `tools/operations/resume-engine-official.mjs` não repete requests nem aceita ordens/preços/valores.

Diferença de principal de até **R$50 em BRL** no diagnóstico completo recebe somente observação administrativa, quando a evidência está completa e fresca. `SHORTFALL` e o déficit exato permanecem. O diagnóstico da grade inteira nunca foi gate de retomada: essa observação não acrescenta dinheiro, não autoriza BUY sem Spot integral, não afasta BNB/ownership/caps/TP nem se aplica a USDT. Dados antigos/incompletos não recebem certificação. Nenhum depósito, ajuste de ledger, ordem artificial ou migração é necessário.

Um retry explícito de PAUSE para run já PAUSED revalida a proteção sob lease; status sozinho não é certificação. Nenhuma pausa/global kill de outros motores ou executores é executada.

## Ocultação persistente e segura

Ocultar é metadata por `operator_id + exchange_account_id`, não resolução de alerta nem alteração de saúde. A API ADMIN exige host Production canônico, Origin, JSON e header de intenção. Resolve operator/account/engine/run no servidor; VIEWER e anônimo não podem executar o controle. A preferência e a trilha imutável têm RLS e RPC service-only SECURITY INVOKER, nonce idempotente e lock por conta.

HIDE exige inventário atual exato, todos os motores PAUSED e gates fechados, reconciliação recente, 25 slots/contas únicos, leitura integral de ordens/alertas, namespace CoinOps canônico, zero BUY residente/pendente/ambígua, fills reconciliados, exposição dentro do cap e cobertura TP comprovada pelo step oficial. O evento de prova precisa ter `protection_verified=true`, `quantity_step`, `open_positions` e `resident_buy_count=0`. O RPC revalida inventário, estado do run e gates na transação da preferência. Falha parcial não oculta a conta nem desfaz a pausa bem-sucedida dos motores anteriores.

A Home revalida o snapshot a cada leitura, sem chamar exchange ou reconciliador. Dados completos, namespace público calculado server-side, saldo físico não negativo e freshness são obrigatórios. Batch RPC canônico agrega todas as ordens/alertas; leitor legado pagina com count. O fallback nativo limitado não certifica ocultação. Falha da leitura opcional da preferência deixa a conta visível; não derruba o painel.

Somente a projeção ALL da Home exclui cards, avisos de saldo reconhecidos, feed e agregados da conta oculta. Sincronização, ledger, selector, relatórios, notificações e proteção continuam. Seleção direta mostra **PAUSADO · POSIÇÕES PROTEGIDAS**, nunca OPERANDO. Se todos estão pausados, o painel mostra COMPRAS PAUSADAS, não operação ativa fictícia.

**Falha crítica, ownership inválido, TP ausente/insuficiente, fill pendente, cap excedido, configuração pendente, leitura incompleta ou stale reexibe a conta e o aviso.** Não forçar verde. Reexibir na tela inicial não retoma compras e independe da disponibilidade do snapshot financeiro. Ao retomar um motor pelo fluxo existente, a condição de ocultação deixa de valer automaticamente.

## Watchdog e auditoria

Watchdog observa ACTIVE e PAUSED. A pausa intencional protegida é contada separadamente (`paused_engines`), com TPs monitorados; não como motor comprando. Incidente real tem precedência. Recovery PAUSED usa o mesmo reconciliador, sem abrir gates de BUY. Não alterar cron, polling Binance ou capacidade.

`LIVE_PAUSED` e `RECONCILED` mantêm evidência por operator/account/engine/run. Relatórios exportam o contrato e a evidência de pausa. `account_home_preference_events` mantém auditoria imutável de HIDE/SHOW por nonce/engine inventory; não é gain, trade nem autorização financeira.

`LIVE_RESUMED` permanece no export LIVE_EXECUTION com a mesma identidade. O novo botão não introduz evento financeiro alternativo nem muda o formato v24 dos relatórios. A observação de R$50 é explicação de diagnóstico, não regra da Strategy Engine.

Migration aditiva: `20261013145823_add_account_pause_home_preferences.sql`, somente schema coinops no projeto oficial. Cria duas tabelas metadata/RLS/RPC e acrescenta contador de pausados ao Watchdog. Não modifica linhas financeiras existentes.

## Regressões e reprodução offline

- PAUSE idempotente, lease ocupado, cancel/fill concorrente, estado ambíguo, gain durante pausa, último TP sem reset e siblings intactos.
- SQL/RLS real em PostgreSQL em memória: owner, outro operator, anon, VIEWER, service-only, inventário novo, stale/config gates, nonce/collision, audit insert-only e SHOW sem resume.
- 515 alertas/CRITICAL final, >500 ordens, count desconhecido, namespace estrangeiro, lote descoberto, saldos inválidos, leitura parcial/stale e preferência indisponível.
- Mobile 390px e desktop 1440px: selector preservado, ocultação, falha reexibida, confirmação/double-click, requests sequenciais e falha parcial sem HIDE/retry.

Para o teste SQL isolado, instalar **somente** o harness versionado pelo lockfile:

```powershell
npm.cmd ci --prefix tools/testing/account-pause-sql --ignore-scripts --no-audit --no-fund
```

Depois, em `apps/web`:

```powershell
node --experimental-strip-types --test lib/execution/account-pause-home-sql.test.ts
```

O harness não lê `.env`, não usa Supabase remoto e não faz trades. Nenhuma pausa, ordem, cancelamento ou registro financeiro REAL deve ser criado como smoke desta funcionalidade. A decisão de pausar a conta é do usuário ao confirmar o novo botão.
