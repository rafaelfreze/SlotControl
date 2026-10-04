# ENTRY não enviada e orçamento por conta

Incidente Dete/BTCBRL em 04/10/2026: a amostra concluída às 19:49:39.866Z
ficou junto da fronteira Binance de 10s (19:49:40Z). A decisão foi persistida
DISPATCHED às 19:49:40.083Z antes de construir o permit/fazer fetch. A rejeição
local não tinha prova tipada, deixando uma ENTRY PREPARED/guarded ambígua.
A compra inicial já estava FILLED e protegida por TP; não repetir MARKET.

## Contrato

- Reserva exige pelo menos 4s restantes, recolhendo novamente só a evidência
  read-only se necessário. Não estende janela Binance nem presume reset.
- Rejeição síncrona do permit antes de fetch produz prova escopada; timeout,
  erro de exchange ou erro textual genérico nunca produzem essa prova.
- Ordem antiga só é candidata se ENTRY BUY PREPARED, sem exchange ID, execução
  ou quote, decisão DISPATCHED sem ACK/completion e idade >=90s. Não recuperar
  automaticamente INITIAL/MARKET por esse mecanismo.
- `/v1/prove-unsent-order` assinado exige account policy instalada e ownership
  exato por engine. Não tem POST/DELETE Binance. Instala fence privada para a
  chave canônica da ordem, rejeita claims `.pending`/`.json` antes/depois do GET
  exato e só então assina a ausência durável. IO/corrupção/fill/claim falham fechados.
- Todo POST de ordem verifica a fence sincronamente imediatamente antes de
  fetch, após as leituras de clock. Request anterior à fence não pode acordar
  e enviar depois da prova. Novo despacho, com novo timestamp e permit, mantém
  o mesmo clientOrderId; claims anteriores nunca são apagados pela recuperação.
- RPC existente `release_proven_unsent_account_order` confere escopo, lease,
  estado e timestamp exatos e persiste `ACCOUNT_ORDER_NOT_SUBMITTED`. Guard
  histórico não é apagado. `claim_proven_unsent_account_order` consome a prova
  uma vez. Não há UPDATE manual de ordens, decisões ou kill switch.
- Uma ENTRY comprovadamente não enviada pode permanecer pendente enquanto o
  motor está protegido. O resume já existente só reabre depois de reconciliação
  completa, TPs, caps, flags parent e incidente único inalterado. Próxima BUY
  segue o reconciliador oficial, não um retry da MARKET.

Relatórios v17 exportam a regra e preservam o evento/decisão de recuperação;
evento de não envio não significa execução. Política comum a todos os shards.
Alteração de runtime exige release revisada, rollout sequencial e fleet parity.
