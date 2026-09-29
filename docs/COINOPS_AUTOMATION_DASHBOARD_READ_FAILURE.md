# Automação: timeout de leitura do painel (28/09/2026)

## Evidência e causa

O GET `/automacao?view=testnet&account=ALL` exibiu o error boundary às 19:15 no horário local. O log da Vercel registrou `COINOPS_ENGINE_LEDGER_UNAVAILABLE` às 23:12:37 UTC. No Supabase oficial (`otdfpmsegjxpqrzisfmi`, schema `coinops`), o PostgREST registrou `57014`/statement timeout às 23:12:49 UTC para uma leitura de `robot_v1_live_events` com `run_id`, ordenação por `observed_at DESC` e `limit=40`. A tabela já tinha índice `(run_id, observed_at DESC)`; não há evidência de falha de escrita, execução ou ordem.

O read-model carregava motores REAL mesmo na aba Testnet e iniciava leituras de todos os motores nativos em paralelo. Um único erro em qualquer consulta derrubava a página inteira. Isso não demonstra que o executor ou o trading pararam.

## Condição segura e correção

- `presentationEnvironment` limita as leituras nativas ao ambiente solicitado. A Visão Geral mantém os três ambientes por contrato.
- Nas abas Testnet/Shadow, o selo REAL diz `REAL · VER NO PAINEL`; ausência de leitura LIVE nessa rota não é tratada como motor em preparação ou como saúde confirmada.
- As leituras dos motores nativos são limitadas a dois motores simultâneos; filtros `operator_id`, `exchange_account_id`, `trading_engine_id` e `run_id` permanecem intactos. RLS não é alterada.
- Falha de leitura conhecida de um motor retorna somente esse motor como `DADOS INDISPONÍVEIS`/não saudável na apresentação e gera log sanitizado `COINOPS_OPERATOR_ENGINE_READ_FAILED` com código da tabela. Os outros motores continuam visíveis; nenhuma informação é inferida como saudável. Erros inesperados continuam propagando.
- Nenhum retry financeiro, mutação de ledger, reconciliação, cancelamento ou ordem é acionado pelo painel.

## Diagnóstico se voltar

1. Filtrar Vercel pelo GET `/automacao` e `COINOPS_OPERATOR_ENGINE_READ_FAILED`; anotar ambiente e código, sem copiar payload financeiro.
2. Correlacionar horário com PostgREST/Postgres no projeto e schema oficiais. `57014` identifica statement timeout; o código `COINOPS_ENGINE_LIVE_EVENTS_UNAVAILABLE` indica a leitura específica.
3. Verificar se a aba afetada executou consultas de outro ambiente. Testnet não deve consultar `robot_v1_live_*` pelo read-model nativo.
4. Validar saúde dos executores e dos motores separadamente; o card `DADOS INDISPONÍVEIS` não é prova de falha do motor nem de recuperação.
5. Se o timeout persistir na aba REAL, medir plano/RLS e carga da consulta em diagnóstico read-only antes de propor índice, migration ou mudança de política. Nunca desativar RLS em Production para testar.

Regressões: `apps/web/app/automacao/operator-presentation-server.test.ts` cobre isolamento de aba, limite de concorrência e falha fechada por motor. Smoke publicado deve abrir a aba Testnet e a REAL em sessão autenticada, sem clicar controles financeiros, e conferir ausência do error boundary e dos timeouts correlatos nos logs.

## Registry e retomada do PWA (29/09/2026)

O registry (`operators`, `exchange_accounts` e `trading_engines`) é uma dependência crítica e continua fail-closed: sem identidade operacional confirmada, a Home não exibe dados anteriores como atuais. As três leituras compartilham um prazo total de 5 segundos; ao excedê-lo, a requisição é abortada e registra somente `stage`, código sanitizado e duração em `COINOPS_OPERATOR_REGISTRY_READ_FAILED`. Nunca registrar payload, conta, credencial ou resposta bruta do provedor.

Depois de uma falha transitória, uma aba/PWA já aberta pode continuar exibindo o error boundary mesmo com Production recuperada. A tela executa uma única tentativa automática por aba e mantém o botão manual se a falha persistir. Não usar intervalo, reload contínuo, cache de dados operacionais nem retry financeiro. O teste `operator-context-server-timeout.test.ts` cobre o prazo compartilhado e o erro sanitizado; `error-recovery.test.ts` impede regressão para retry infinito.
