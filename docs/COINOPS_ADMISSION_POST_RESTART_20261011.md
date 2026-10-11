# Admissão após restart — diagnóstico e apresentação

CoinOps · Supabase `otdfpmsegjxpqrzisfmi` · schema `coinops` · REAL.

## Causa confirmada

Após o rollout sequencial de 11/10/2026, os processos continuaram saudáveis,
mas a janela de peso Binance em memória começou novamente. A política
`capacity-v3-20260930` exige 15 amostras reais de minuto e depois 600 segundos
contínuos de projeção até 60% para reabrir um gate fechado. Não é saturação
por quantidade de motores nem perda da certificação.

A apresentação usava “telemetria ausente ou desatualizada” também quando a
janela estava incompleta, e “sem espaço” para qualquer recusa. Isso confundia
aquecimento, estabilização, indisponibilidade e falta real de capacidade.

## Correção e fronteiras

A API administrativa expõe a contagem e os timestamps do snapshot existente.
O painel distingue janela incompleta e estabilização server-side, sem criar
ou acelerar o relógio no browser. O motivo e a autorização continuam vindo
exclusivamente do RPC canônico; contagem/frescura visuais nunca autorizam
cadastro, preparação ou ativação.

Não reduzir 15 amostras, 600 segundos, headroom de 35%, certificação,
freshness, health, Watchdog ou limites Binance. Não preencher histórico nem
reescrever `healthy_since`; GET/reload não altera a decisão. Não reiniciar um
executor para tentar liberar capacidade: isso reinicia o aquecimento.

## Verificação operacional

1. Ler registry, `executor_capacity_samples`, readiness e decisões +1/+2.
2. Conferir amostra, heartbeat e weight frescos, registry e runtime exatos.
3. Com menos de 15 amostras, manter a admissão bloqueada e observar as coletas
   oficiais. Contagem suficiente não substitui outros gates.
4. Com janela completa, conferir `healthy_since` e `healthy_seconds`. Somente
   nova coleta oficial avança os 600 segundos; pressão/erro/gap real pode
   reiniciar o prazo. Não prometer um horário garantido de liberação.
5. Confirmar `CAPACITY_OK` pelo preview canônico e pelo painel, sem criar um
   motor ou uma ordem de teste. +1 e +2 são decisões independentes.
6. Incidente real em um engine pode bloquear onboarding daquele shard;
   nunca ocultar a condição para liberar carga ou afetar outro shard.

Mudança exclusivamente de apresentação/read model, sem migration, restart,
credencial, cron ou alteração financeira.

Referência normativa: `COINOPS_ADMISSION_HYSTERESIS_20260930.md`.

## Evidência de 11/10/2026

Leitura oficial às 16:09:46 UTC, sem escrita financeira:

- Executor 01: 15/15 amostras; +1 `CAPACITY_OK`, projeção 57,79%;
  +2 recusado por projeção 72,79% acima do limite de 65%.
- Executor 03: 15/15 amostras; +1 e +2 `CAPACITY_OK`, projeções 26,58% e
  41,58%; estabilização acumulada de 660 segundos pelo coletor.
- Executor 02: 15/15 amostras; `ENGINE_RECOVERY_IN_PROGRESS`, independente
  do aquecimento. Incidente Dete/BTCBRL por reserva BNB insuficiente;
  não liberar onboarding nem apagar claim/alerta para contornar o gate.

Validações: 23/23 regressões SQL em PostgreSQL local descartável,
9/9 testes de coleta, 10/10 testes de apresentação/ativação e 2/2 cenários
de navegador isolados (mobile/desktop). Typecheck, lint e build aprovados.
Regressões confirmam 1–14 amostras fechadas, 15 amostras iniciando a
estabilização, 599s fechado, 600s elegível, reload sem escrita, +1/+2
independentes e reserva única de 2100 weight/min nos três shards.
