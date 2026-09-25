# Automação ao vivo — somente observabilidade

A página `/automacao` usa dois fluxos independentes. O banco `coinops` publica apenas
`automation_refresh_signals`: uma linha por motor com IDs de escopo, ambiente,
símbolo, revisão e horário. Triggers reúnem alterações do ledger, ordens, posições,
alertas, perfil e controles em um sinal por transação/motor. Nenhum saldo, ordem,
payload de evento, `credential_ref`, API Key ou Secret entra nesse canal.

O browser assina uma única conexão Realtime para os motores selecionados. Cada
evento é aceito somente quando ambiente, conta, motor e símbolo coincidem. A RLS
permite ao admin/operator apenas seus motores e ao VIEWER apenas a conta vinculada.
Ao receber sinal, o Next faz um refresh autenticado do snapshot completo; a
assinatura anterior é removida quando o filtro ou a visibilidade muda. Há debounce
de refresh e fallback periódico (30 s reconectando; até 120 s conectado).
Após retornar à aba, o snapshot é recuperado antes de confiar em eventos perdidos.
Após 150 s sem snapshot novo, o cabeçalho informa `DESATUALIZADO`.

Preços usam um único WebSocket **público de market data** da Binance para os
mercados visíveis e as referências BTC/SOL em USDT. Ticks são agrupados por um
segundo no cliente. Em desconexão, um GET público em lote a cada 30 s mantém a
referência; após 45 s sem preço fresco, o preço é marcado como desatualizado.
Esses preços atualizam apenas a apresentação e P&L estimado, nunca o ledger,
estratégia, TP, ordem ou reconciliação. Testnet usa cotação Production apenas como
referência visual, sem a confundir com fill fictício.

O executor e o cron continuam independentes do browser. Fechar a página, perder a
rede ou trocar de conta não inicia, pausa ou modifica um motor.

Para validar em produção: abrir Real/Rafael e Real/Thyely em abas separadas,
confirmar `AO VIVO`, simular perda/reconexão de rede e retorno de aba, verificar
console sem erro e comparar o próximo evento **natural** do ledger com o snapshot
após atualização automática. Não criar ordens reais apenas para testar a UI.
