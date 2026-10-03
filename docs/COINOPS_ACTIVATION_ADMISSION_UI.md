# Admissão na ativação de um motor preparado

Em 03/10/2026, Samya/SOL iniciou no Executor 03. Um incidente transitório de
reconciliação foi resolvido; a admissão permaneceu `RECOVERY_STABILIZING` pela
janela canônica de 600s. Samya/BTC tinha 25 slots preparados, sem ordens, mas o
painel exibia READY e permitia tentativas que retornavam `COINOPS_CAPACITY_REQUIRED`.

Preparação de slots não equivale à admissão. O GET administrativo consulta uma
única decisão `preview_executor_admission` (+1 motor) para a conta selecionada
com ciclo REAL PREPARING. A UI mantém os slots preparados e apresenta
`PREPARADO · AGUARDANDO ADMISSÃO`, o motivo e a espera restante **na amostra
persistida**, sem iniciar cronômetro nem recomputar capacidade no browser.

`Atualizar estado · sem ordens` faz somente GET interno. Ausência/falha de
evidência desabilita nova ativação, nunca pausa um motor ACTIVE. Após CAPACITY_OK,
o botão fica disponível, mas a ativação ainda revalida snapshot Binance,
identidade, reserva serializada, registry e ledger. Nenhuma política, headroom,
ordem, TP, NEXT BUY, estratégia ou runtime de VPS foi alterado por esta correção.

Na leitura de 19:17:42 America/Campo_Grande, o coletor liberou automaticamente
o gate: pressão sustentada 496,56 + incremento conservador 900 = 1396,56/min,
23,28%, abaixo de 3900/min (65%); reserva de recuperação 2100/min preservada.
Não foi forçada a liberação e não foi executada ativação pelo agente.
