# CoinOps: auditoria de isolamento e escala (2026-09-25)

Status: **COINOPS_50_ACCOUNTS_READY = REPROVADO**. Este documento separa
evidência medida de projeção. Nenhuma falha foi induzida na Production e
nenhuma ordem foi criada ou cancelada nesta auditoria.

## Topologia verificada

- Vercel Cron chama `/api/cron/live-execution` a cada minuto, com duração
  máxima configurada de 60 s. Descobre runs ACTIVE/PAUSED e chama
  `advanceLiveRun` de todos via `Promise.all`, sem limite de concorrência.
- Cada run usa lease próprio em `robot_v1_live_runs`; falhas tratadas por
  `advanceLiveRun` acionam kill switch e alerta do engine, não de toda conta.
  O cron agrega uma falha local como `PARTIAL_FAILURE` HTTP 503.
- Executor VPS usa registro estático + dinâmico, roteia por
  operator/account/engine/market e referencia credencial de cofre por conta.
  A criação de ordens usa idempotência persistente e consulta antes de
  repetir uma resposta incerta.
- O navegador assina Realtime por contexto selecionado, não por slot. Em
  "Todos", porém, adiciona um filtro por engine; o carregamento inicial
  também solicita health por engine. Não há medição de 100 engines no
  navegador nem prova de ausência de vazamento/assinatura órfã em longa duração.

## Falha sistêmica encontrada e corrigida localmente

Antes, uma referência inválida em **uma** conta do registro dinâmico fazia
o registro combinado inteiro falhar e o executor voltar apenas às contas
estáticas. Assim, uma conta nova defeituosa retirava as outras contas
dinâmicas saudáveis do roteamento. Agora a validação separa as entradas por
conta; rejeita o grupo inválido, conserva os irmãos válidos e valida o
conjunto final. Referências cruzadas e IDs duplicados continuam proibidos.

Regressão sintética: 10/30/50/100 contas com 2 engines por conta, mais
2 engines estáticos, verificando roteamento da conta saudável final. O
cenário de 100 contas rejeita corretamente cinco contas com credencial
ausente e mantém os 95 grupos saudáveis. A carga corresponde a
500/1.500/2.500/5.000 **slots lógicos**, não a slots persistidos, fills,
TPs ou ciclos executados. Os 35 testes do pacote `live-executor` passaram.

O arquivo JSON dinâmico continua sendo um ponto único: se estiver ilegível
ou não puder ser decodificado, todas as contas dinâmicas falham fechadas.
As operações administrativas de escrita também validam o arquivo inteiro.
Essa correção local ainda não foi implantada no executor LIVE.

## Medições e limites

| Perfil | Medido | Resultado |
| --- | --- | --- |
| 10 contas / 20 engines | Merge do registro em memória | p50 0,48 ms; p95 0,97 ms; RSS do processo 51,6 MB |
| 30 / 60 | Merge do registro em memória | p50 0,97 ms; p95 9,28 ms; RSS 52,7 MB |
| 50 / 100 | Merge do registro em memória | p50 1,42 ms; p95 1,96 ms; RSS 53,8 MB |
| 100 / 200 | Merge do registro em memória | p50 2,99 ms; p95 8,1 ms; RSS 53,9 MB |
| Banco atual | Snapshot read-only | 4 accounts, 12 engines, 6 runs ACTIVE/PAUSED, 200 slots de múltiplos ciclos, 34 ordens, 8.756 eventos, 0 alertas abertos |
| Cron atual | Logs read-only recentes | Minutos amostrados: 6 runs OK; não extrapola para 100/200 engines |

As latências e o RSS acima medem **somente o merge local do registro**, não
CPU/RAM do executor sob reconciliação, rede, Binance, Supabase ou push. O
snapshot do banco e os logs representam apenas o momento consultado.

## Riscos não aprovados

1. `Promise.all` dispara 100–200 runs simultâneos no cron de 60 s.
   Não há fila limitada, fairness nem medição de backlog/cron overlap em carga.
2. O snapshot do executor faz até seis leituras Binance em paralelo por
   engine e pode repetir um snapshot após falha transitória. Não existe
   orçamento de REQUEST_WEIGHT compartilhado por IP/credencial. O adapter
   read-only repete HTTP 429 após 100 ms, sem respeitar `Retry-After`.
3. O ledger emite `RECONCILED` por run/minuto. A 100 engines, isso
   projeta aproximadamente 144 mil eventos/dia, **não medidos**. Uma query
   de eventos acumulou 1.853 chamadas com média histórica de 486,6 ms em
   `pg_stat_statements`; o período de coleta e p95 não foram apurados.
   Causa da latência ainda não provada.
4. O Realtime usa um canal, mas até um filtro por engine selecionado;
   limites reais dependem do plano e do tráfego. Não foi medido o comportamento
   de 2.500 slots nem o retorno de background em 100 engines.
5. Não houve harness ponta a ponta de milhares de fills, TPs, resets,
   crash/restart, resposta incerta, alertas push, RLS e recovery simultâneo.
   Portanto não existem p50/p95/p99, backlog e tempo de recuperação
   confiáveis do fluxo completo.

## Gates

| Gate | Estado |
| --- | --- |
| MULTI_ACCOUNT_ISOLATION_PASS | Parcial: roteamento/credenciais sintéticos; falta execução concorrente |
| ENGINE_BLAST_RADIUS_PASS | Parcial: 1 e 5 contas inválidas isoladas no registro; faltam falhas de operação |
| BINANCE_RATE_LIMIT_PASS | Reprovado |
| SCHEDULER_CONCURRENCY_PASS | Reprovado |
| RECOVERY_AT_SCALE_PASS | Não testado |
| DATABASE_SCALE_PASS | Não comprovado |
| REALTIME_SCALE_PASS | Não comprovado |

Próximo gate técnico: harness totalmente sintético do cron e executor,
com latência, memória, REQUEST_WEIGHT, falhas 1/5/credencial, fairness,
restart e 2.500 slots reais em fixture. Só então limitar concorrência e
otimizar consultas conforme gargalos medidos. Não modificar ordem LIVE para
obter benchmark.
