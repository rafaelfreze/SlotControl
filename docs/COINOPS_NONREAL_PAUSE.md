# Pausa operacional Shadow e Testnet

`/automacao` abre em Real no web e no mobile. A Visão Geral permanece em
`/automacao?view=overview`; Shadow e Testnet continuam consultáveis.

- Shadow: Pausar Shadow marca somente o engine selecionado como `PAUSED`, liga
  seu kill switch e pausa novas entradas na configuração. O cron ignora engines
  pausados. Iniciar Shadow reativa o mesmo ciclo e histórico.
- Testnet: Pausar Testnet adquire a lease do ciclo, compara as ordens próprias
  residentes com o ledger e, após leitura individual, cancela apenas IDs
  próprios no Binance Spot Testnet. Registra snapshot/cancelamentos no ledger,
  preserva slots, fills, gains e posição fictícia, e marca o ciclo `PAUSED`.
  Divergência ou fill concorrente falha fechado; nunca usa `cancelAllOrders`.
- Iniciar Testnet exige 25 slots, Binance Testnet sem ordens próprias
  divergentes e ledger sem ordem ativa. Mantém novas BUYs bloqueadas enquanto
  reconcilia e restaura TPs das posições fictícias; somente após conferir a
  cobertura de todas as posições libera uma próxima BUY.
- Os controles são por engine, conta e ambiente. Nenhum deles altera Real,
  hard caps ou ordens Production. O reactor de Testnet permanece agendado para
  futura reativação, mas retorna cedo sem consultar Binance quando não há
  engines Testnet ativos; o watchdog redundante de cinco minutos foi removido.

Se a pausa ou reativação falhar, verificar a mensagem codificada, o status do
engine/ciclo e as ordens Testnet diretamente antes de repetir a ação. Nunca
inferir que uma posição fictícia está protegida durante a pausa; os TPs são
restaurados na reativação.
