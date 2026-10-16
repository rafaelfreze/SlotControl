# Recertificação direcionada de slots — 16/10/2026

Produto CoinOps, SlotControl/main; OnPlay Platform `otdfpmsegjxpqrzisfmi`,
schema `coinops`. Plano vigente: Thyely/SOLBRL/Executor03, **50 × R$22 = R$1100**,
gain3%, meta3 gains/slot/mês, spacing2% normal/3% pós-ATH. O plano100 × R$11
está abandonado e não é usado como requisito para admitir50.

## Veredito pré-publicação

**NÃO CERTIFICADO; não criar/ativar o novo motor com a evidência atual.**
Não há prova de saturação de CPU/RAM do VPS. Há amplificação real de leituras
no fluxo canônico e falta de um envelope agregado de request weight comprovado
para picos, inclusive com retries e motores irmãos. `SLOT_WORKLOAD_UNCERTIFIED`
significa ausência desse perfil, não falha de um teste fictício de50 BUYs.

As grandezas foram separadas:50 slots lógicos, até50 TPs e uma NEXT BUY;
eventos de preenchimento/reconciliação não equivalem a50 BUYs simultâneas.
Os filtros por conta/par continuam somados entre todos os shards.

### Evidência que impede o PASS

- Fluxo completo50, com cadência real de60s, filtros globais e falhas transitórias:
  três passagens3134/3084/2404; maior janela móvel60s4933 e maior minuto
  alinhado4552 no inventário conservador agregado. Episódio134,179s, cincoPOSTs,
  doisDELETEs,24gains únicos, TPs protegidos e uma NEXT BUY ao final.
- Todos os hosts públicos/privados são discriminados no harness; a soma é uma
  escolha conservadora da certificação, **não prova de429 ou de violação da
  quota física oficial da Binance**. Os valores do episódio não são peso/min.
- Burst financeiro simultâneo de50+25+25 no mesmo account/symbol/shard:
 8515 total =5707 API +2808 público em20,5s, oitoPOSTs, zeroDELETE;
  ledgers/gains/successors/ownership convergem, mas não há headroom ordinário
  certificado. API sozinho5707 já ultrapassa o envelope3900 da política.
- Snapshot oficial03 às20:06:59Z: média771,25, atual730,16amostras.
  ContratoV1 exige unidades inteiras de900; um trace3134 requer pelo menos4
  unidades,3600. Preview oficial4: **4371,25 >3900**, falta471,25.
  A reserva de recovery2100 está descontada uma única vez pelo teto3900.
  A histerese de reabertura3600 também não pode ser ignorada.

Traces não constituem limites universais. Os picos acima são contraexemplos
reproduzíveis, não estimativas de latência ou consumo LIVE. Ver evidência e
limitações em `coinops-fifty-fill-directed-tests-20261016.md` e
`coinops-fifty-control-flow-bound-20261016.md`.

## Correções implementadas, sem relaxar segurança

1. Observação autenticada e coerente da ordem própria e seus fills paraN>25:
   elimina query duplicada, confirma totais/races por GET limitado e nunca
   autoriza reenvio de POST/DELETE financeiro. Motores25 conservam o protocolo.
2. Reuso somente da cotaçãoBNB por até60s no mesmo escopo/invocação;
   nenhum saldo, filtro ou snapshot de ordens é reutilizado para autorizar escrita.
3. Boundary cooperativo depois de BUY reconciliada/protegida, com checkpoint
   SQL/lease/CAS e fatos persistentes, sem fabricar `last_reconciled_at`.
4. Prova SQL independente dos fills parciais deTP sem promover flag terminal;
   Watchdog diferencia prova indisponível de fill realmente não reconciliado.
5. Coleta de budget que cruza a janela retorna409 tipado com fatos originais
   completos. O web valida tudo e alinha a próxima leitura. O409 nunca é
   gravado como orçamento fresco e não autoriza ordem. Witness real reduz
   seis probes para quatro:1194→796 (trêsmercados) ou1806→1204 (global/quatro).
6. Perfil não legado ligado ao fingerprint das fontes financeiras web e ao
   runtime/política/shard exatos. Mudança financeira invalida o perfil;
   docs/UI não relacionadas não exigem recertificação indevida.

Contrato de relatórios27; nenhum histórico financeiro reescrito. Duas migrations
aditivas de funções/ACL, sem UPDATE de estratégia, slot, posição ou saldo:
`20261016192533` e `20261016193756`. Aplicação remota/deploy devem ser confirmados
separadamente; este documento pré-publicação não declara essas etapas concluídas.

## Menor caminho seguro restante

Eliminar a amplificação remanescente das leituras legadas de25 e provar um
envelope porIP sob burst/retry/cron/recuperação concorrentes, priorizando proteção
e reservando headroom antes de novas entradas discricionárias. Depois, repetir
os testes afetados e registrar o perfil exato50 somente se todos passarem.
A variante de cotação para25 foi testada apenas offline (5462 no mesmo burst),
não publicada: ainda excede3900 e não comprova headroom. Só arredondar o perfil
V1 ou aumentar CPU/RAM não resolve essa evidência. O modelo contínuoV2 é proposta,
não foi ativado para conseguirPASS.

Não houve teste de ordem REAL, cancelamento artificial, movimentação de saldo,
criação de motor, alteração econômica dos16 motores existentes ou novo executor
para obter esses resultados.100 slots continuam suportados pelo código, porém
sem certificado operacional — resultado informativo independente do plano50.
