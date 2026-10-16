# CoinOps — auditoria de desempenho de 16/10/2026

Escopo: painel web da Automação e confirmação somente leitura da saúde operacional.
Backend conferido: `otdfpmsegjxpqrzisfmi`, schema `coinops`, produção. Não houve
migration, ordem, recovery, ativação, pausa, restart de executor ou mudança de estratégia.

## Evidência operacional

Consulta oficial às 12:18:05 UTC, em transação `READ ONLY`, encontrou:

- 16 ciclos `ACTIVE`, nenhum `last_error`; últimas reconciliações entre 12:17:18 e 12:17:34 UTC.
- Três executores com heartbeat às 12:17:41 UTC; backlog, erros e retries de 5 minutos iguais a zero.
- CPU entre 0,851% e 2,997%; RAM entre 114,26 e 141,27 MB de 961,48 MB.
- Binance weight observado: 2.467, 2.432 e 677 por executor, com limites independentes de 6.000.
- Mesmo `executor_version` nos três: `8dc5eb49de9ceb63ff63ffd643c8354645623808`.

Isso não mostra saturação ou robô parado nesse instante. Não representa uma
certificação contínua nem substitui os gates de admissão, proteção e paridade.
Os logs oficiais também mostraram execução concluída com 16 resultados `OK` às
11:30 UTC; `LEASE_BUSY`/`BUSY_OR_INACTIVE` em outra execução não comprovam falha.

## Gargalos corrigidos

1. A Home LIVE ainda enviava sete consultas históricas com `limit(0)`. Elas
   consumiam requisições mesmo sem retornar linhas. Agora a condição evita o
   envio; as páginas históricas mantêm consultas, limites e isolamento.
2. Dois builders PostgREST guardados como "Promise" permaneciam lazy até o
   `await` posterior. A assimilação explícita inicia ajustes e limites de conta
   junto das demais leituras independentes, sem reexecutá-los no consumo.
3. As quatro leituras independentes de configuração LIVE aguardavam a conclusão
   do ledger. Agora começam junto dele; o resultado continua validado antes de
   compor a apresentação, mantendo todos os filtros de identidade.

Medição determinística com o client Supabase real e transporte de teste: o grupo
de consultas base LIVE passou de 12 para 5 GETs (sete a menos). Histórico continua
com 12, sem consulta de limite zero. Os testes também verificam schema, método
GET, filtros de conta/motor e ausência de segunda execução ao aguardar os resultados.

Antes da alteração, um log real de `/automacao` registrou 2.155 ms server-side
(auth 61; registry 569; base 416; legacy 228; projeção 849; painéis 34), às
11:26:52 UTC, release `a652d32`. Esse é um ponto observado, não um p95. A redução
de requisições não deve ser divulgada como igual redução percentual no tempo
total; o tempo autenticado após publicação precisa ser observado separadamente.

## Validação e preservação

Testes direcionados abrangem orçamento de rede, agrupamento de motores,
isolamento por ambiente/conta/motor, freshness, falhas parciais do ledger,
histórico opcional, limites de concorrência e ciclo de leitura dos saldos.
Foram aprovados 43 testes direcionados, lint dos três arquivos de código,
typecheck e um build Next.js 14.2.35. O build preserva avisos existentes de
autoprefixer (`start`/`end`) e uso de `process.version` do Supabase no Edge;
nenhum deles impediu a compilação. Nenhum pacote foi atualizado.

As mudanças ficam apenas no grafo web de leitura. O cron e o código dos
executores não foram alterados; não há motivo técnico para reiniciar VPS.
RLS, autorização, status financeiro, capital, ordens, TP e NEXT BUY permanecem
resolvidos pelos fluxos existentes.
