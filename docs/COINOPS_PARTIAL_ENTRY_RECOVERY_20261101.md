# Recuperação de parcial terminal sem TP — 01/11/2026

## Causa e prevenção

Dete/SOLBRL, slot 8/operação 3, pediu 2,187 SOL a R$513,10
(R$1.122,1497). A Binance executou somente 0,004 SOL (R$2,0524).
O fluxo antigo cancelou o restante antes de validar se esse fragmento permitia
TP. O mínimo Binance é R$10; não houve uma estratégia de comprar R$2.

A proteção preventiva já verifica o mínimo do TP antes de cancelar o restante
de uma BUY parcial própria. Se ainda não for protegível, preserva a mesma ordem
residente, fecha novas entradas e continua reconciliando. Quando os fills
permitirem TP, o fluxo normal protege e a recuperação tipada pode retomar.
Isso não garante fills futuros nem permite recriar ordem cancelada externamente.

## Resgate legado autorizado

O proprietário pediu resolver a parcial no mesmo slot, dentro do capital
autorizado. `ORPHANED_PARTIAL_RECOVERY_V1` não muda a estratégia de tamanho cheio
das próximas entradas. É uma única compra complementar mínima para permitir
proteger a posição parcial já existente, com identificação financeira separada.

O controle autenticado `/api/cron/live-control`, ação `PARTIAL_RECOVERY`, recebe
apenas account/engine/asset/run/slot/operação. Resolve valores no servidor.
Exige fonte terminal própria com fills exatos, incidente TP_FILTER no mesmo
episódio, 25/25 (ou N canônico) completos, todos os outros TPs protegidos,
ausência de outra BUY residente e filtros/BNB frescos. Salva autorização/evento
imutáveis; não envia a ordem no controle. Resposta incerta exige readback.

O worker normal usa a mesma lease, planner de recuperação, journal query-first,
clientOrderId único, guard de dispatch e ledger. O complemento é o mínimo
nocional arredondado à quantidade executável mais um step, com quote a centavos
para cobrir flooring. Não aumenta capital nem usa saldo de outro slot. A soma
do custo já executado e do complemento não pode ultrapassar o saldo próprio;
hard caps de conta/motor, caixa Spot, BNB e limites Binance continuam vigentes.

A RPC `prepare_live_partial_entry_recovery` valida novamente o snapshot, evento,
fills, custo, lease, configuração, incidente, caps e exposição agregada. Nunca
edita o parent cancelado nem muda a sequência da operação. A reserva canônica
aceita somente essa exceção comprovada ao bloqueio local; outros bloqueios e
pausa intencional continuam vetando. Reutiliza o crédito de TP ainda reservado
para a BUY original quando existir, sem duplicar headroom.

O runtime anuncia `partial_entry_recovery_protocol=1`. Antes do POST consulta
novamente a origem e seus fills, confirma terminalidade/ownership, quote mínimo
limitado, ordens próprias, caixa, BNB e caps. Kill switch nativo/global continua
vetando BUY. Timeout/503 não autoriza novo ID nem segundo POST às cegas.

O TP combina exclusivamente a origem parcial e o complemento do mesmo slot e
operação, ambos terminais e reconciliados. O nativo consulta as duas ordens e
fills, deduz taxas em base e verifica saldo livre e ausência de outro TP próprio
nesse slot. Preço usa média real dos fills com o gain original; TPs antigos não
são cancelados. Uma resposta perdida no TP recupera seu próprio ID.

O gate local permanece fechado até todos os TPs e a reconciliação estarem
comprovados. O fluxo existente VERIFIED_TP_FILTER_RECOVERY faz a retomada com
lease/CAS do incidente exato e registra a recuperação no Watchdog. Ganho só é
creditado quando o TP executa; o RPC canônico agrega as duas BUY e suas taxas,
credita **um** gain e preserva idempotência. Um complemento ainda insuficiente
ou incerto permanece bloqueado; nunca há um segundo complemento automático.

## Schema, auditoria e testes

Migration `20261101175946_live_orphaned_partial_entry_recovery.sql`, schema
`coinops`, projeto OnPlay Platform `otdfpmsegjxpqrzisfmi`. Funções de recuperação
são SECURITY INVOKER com EXECUTE somente service_role. A atualização da reserva
exige correspondência exata do contrato remoto antes de compor a exceção.
Nenhuma migration movimenta dinheiro ou cria ordens.

Relatórios v32 exportam autorização, parent, complemento, fills, TP e decisão
nos datasets existentes. `ORPHANED_PARTIAL_RECOVERY_AUDIT` distingue cadeia
completa, autorização pendente, fonte incompleta, duplicação e divergência de
operação. Evidência persistida não certifica a Binance atual. Snapshots antigos
permanecem com a semântica original.

Testes offline: quote mínimo BTC/SOL, autorização/preparação pelo worker,
parcial residente preservada, fonte alterada/estrangeira, gates, BNB, caps,
orçamento Binance, crédito de proteção não duplicado, perda de resposta,
replay/crash, TP combinado/oversell, irmãos intactos, anon/auth negados e
fechamento com duas BUY, todas as taxas e exatamente um gain. Nenhum trade LIVE
é feito para teste; a execução real exige o controle autorizado e prova fresca.
