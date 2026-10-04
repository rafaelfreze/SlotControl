# CoinOps — contrato multi-engine / multi-shard

## Decisão e estado

Requisito autorizado em 04/10/2026: **a conta não é presa ao shard; o engine é**.
N motores podem compartilhar conta e símbolo e residir em N executores, sujeitos
à capacidade e aos limites reais da Binance. Não mover motores existentes.

**Implementação validada localmente; publicação ainda não liberada.** Este documento não é
certificação nem prova de deploy. Base local/origin main reconferida:
`d71731cf722a0f1eaac838b55e1bb545174a2589`. A publicação exige a sequência
versionada abaixo; nenhum teste local autoriza declarar rollout concluído.

## Auditoria e causa

O fluxo anterior só oferecia provisionamento para conta INACTIVE sem motores;
o schema impunha unicidade `(exchange_account_id, environment, symbol)` e
transporte, health, admissão e cron usavam o shard primário da conta. Somente
acrescentar um botão ou remover a constraint não estabelece isolamento.

Também havia cálculo de exposição agregado por BTC/SOL, incompatível com dois
motores do mesmo ativo; caps precisam separar `engine_id` e manter o cap global
por conta/moeda. FinOps deve contar a carteira física uma vez, alocando capital
e motores aos respectivos shards sem somar a carteira por conexão.

## Identidade e invariantes

- Escopo completo: operador, conta, engine, ambiente, símbolo e shard.
- `trading_engines.executor_shard_id` é a autoridade imutável de execução.
  Backfill deriva o vínculo já instalado, sem mudar local de nenhum motor.
- `exchange_accounts.executor_shard_id` fica como bootstrap legado; nunca
  fallback de engine inexistente ou autoridade para engine novo.
- Slots físicos, runs, estratégia/versionamento, ATH/regime, meta, cap, ledger,
  recovery e leases/locks pertencem ao engine. Nenhum estado é reutilizado.
- A identidade física Binance permanece única por conta/operador. Conexões
  adicionais não criam outro dono nem outra conta lógica para a mesma carteira.
- Namespace de ordens inclui account/engine. Preservar COR1 dos motores legados;
  novos motores usam C2 e colisão de prefixo falha antes de provisionar.
- Cancel/recovery/query/fill exigem ownership exato. `CANCELED` e orderId isolado
  não autorizam adotar/reconciliar uma ordem de outro engine.
- Uma falha fica no engine/shard correto; Watchdog não afeta irmãos por símbolo.

## Credencial / whitelist

Cada conta/executor possui evidência própria de credencial/whitelist no IP do
registry oficial e ambiente REAL. Backfill começa `VALIDATION_REQUIRED`, sem
inventar PASS. O proprietário mantém IPs anteriores na whitelist Binance e
informa a credencial no painel via HTTPS ao executor adicional. Não copiar
vault, secrets, UID, registry, locks ou filesystem entre servidores/computadores.
Dados persistidos no control plane são apenas referência e prova, nunca chave.

Suporte Binance a whitelist não prova a configuração de uma chave concreta:
o executor de destino precisa validar a própria conexão assinada. Nenhum smoke
envia trade. CONNECT idempotente não substitui chave já instalada; diferente
identidade/credencial exige o fluxo explícito de segurança, nunca fallback.

## Orçamento e self-trade prevention

Request weight é por IP; `ORDERS` é compartilhado pela conta, entre chaves/IPs.
Filtros `MAX_NUM_ORDERS`, `EXCHANGE_MAX_NUM_ORDERS` e filtros específicos da conta
também precisam ser projetados. O probe explícito usa GET assinado
`rateLimit/order` e `myFilters`; não consulta histórico completo nem escreve
ordens. Amostra ausente, expirada, intervalo virado, filtro não suportado ou
inventário incompleto bloqueia apenas nova admissão, sem falso zero.

Projeção residente conservadora: ordens externas + 26 por engine
(25 proteções possíveis e uma NEXT BUY), versus o limite real do filtro.
Não é cota fixa de motores. O orçamento ORDERS demanda reservas serializadas
por conta, incluindo proteção/recovery; amostra posterior à reserva não elimina
um POST sem resultado confirmado. A deduplicação local do probe não substitui
lease/serialização account-global entre shards. O relógio assinado determina
as janelas; reload não prova reset de contador Binance.

Dois engines do mesmo par também podem cruzar entre si. Todos os transportes
participantes precisam forçar `EXPIRE_TAKER` quando oficialmente suportado:
o taker pode expirar, mas o maker residente do irmão é preservado. Nunca aceitar
EXPIRE_MAKER/BOTH do caller nem cancelar/reprecificar TP para contornar STP.
`EXPIRED_IN_MATCH` com fills continua reconciliando o executado e sua proteção.
Suporte do símbolo não é, sozinho, prova de enforcement em cada runtime.

Fontes oficiais:

- [Account REST e filtros assinados](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/account)
- [ORDERS compartilhado e decrementos](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/order_count_decrement.md)
- [Self-trade prevention](https://developers.binance.com/en/docs/products/spot/faqs/stp_faq)
- [Filtros](https://developers.binance.com/en/docs/products/spot/filters)

## Fluxo implementado localmente / liberação pendente

`+ Adicionar motor` deve existir em conta já operante, inclusive conta legada.
Escolher/configurar novo engine → consultar todos os shards certificados →
preferir elegível/validado → apresentar executor/IP → validar conexão se preciso
→ preview sem writes → confirmação idempotente → provisionar 25 slots novos
→ gate final serializado → ativação pelo proprietário. Nenhum engine REAL é
criado pela implementação ou por smoke.

Implementados no diff local: conexão adicional pelo painel, orçamento global
serializado com ACK/proteção e enforcement de dispatch, preview/append com
capital livre não duplamente alocado, sincronização de caps e aportes por
partição de engines/shards, compatibilidade staged, UI engine-aware e relatório
v16. O SYNC antigo também particiona por engine/shard e usa append idempotente;
nunca substitui registry de irmãos nem rebaixa engine ACTIVE em um retry.

Capital considera todos os caps da conta/moeda, inclusive staged. Crédito de
posição/BUY exige prova de ownership no ledger e hold observado agora. Dois
snapshots estáveis cercam a leitura; mudança de wallet/ordens falha fechada.
Isso não é transação atômica Binance: a ativação/dispatch revalidam saldo,
filtros, identidade, gates e leases imediatamente antes da operação do dono.

Testes locais passaram: 412 web na suíte ampliada (51 testes opcionais ignorados,
não contados como PASS); 129 do executor; 39 SQL com policy/RLS, backfill,
isolamento, append oficial e concorrência; orchestration de preview/append,
policy entre hosts e sincronização staged; UI Chromium sintética em 390/1440px
com o mesmo SOLBRL em 02/03 e preview sem writes. Não equivalem a credential
multi-IP real, runtime publicado ou smoke Production.

A migration local `20261004125202_add_same_symbol_engine_provisioning.sql` ainda
não foi aplicada. Lint, typecheck e build passaram. Faltam publicação,
migration remota, rollout sequencial, fleet/preflight e smoke Production.

## Publicação obrigatória

Depois de fechar os gates: revisar diff/migration/RLS, testar criação idempotente
sem engine REAL, validar isolamento A/02 e B/03 com mesma conta/SOLBRL, lint,
typecheck/build e UI afetada. Atualizar contrato de relatórios na mesma entrega.
Publicar GitHub/main e uma release comum, com janela rolling version-only.
Antes de cada restart: ler LIVE, reconciliação, TP/NEXT BUY, incidentes e Watchdog.
Reiniciar somente o serviço necessário de um shard; só avançar após HEALTHY,
reconciliado e íntegro. Exigir FLEET_PARITY de todos os habilitados e nova
certificação/preflight. Não retirar headroom nem forçar admission.

Rollback: antes de qualquer conta aderir à política, a release comum anterior
`0f5c1071f30f3859379e3b7ce01b4a9fac9be724` é compatível com os engines atuais
e a migration aditiva (não remover schema nem restaurar estado). Depois de
enrollment, nunca voltar para um dispatcher sem permits ou executor sem STP;
rollback exige uma release compatível `ENGINE_ISOLATION_V2`/protocol 1 e janela
de versão revisada. Marcador de conta é monotônico, não se apaga para passar gate.

## Checkpoint externo desta implementação

Não foram feitos commit/push, migration remota, deploy, restart, mudança de
credencial, whitelist, conta, capital ou ordem. Leituras remotas registraram
15 engines REAL ACTIVE sem kill switch na observação de 04/10/2026 17:57:41 UTC,
Watchdog HEALTHY 7/6/2, backlog/erros zero. Leitura 17:58 UTC: cada ciclo com
25 slots, TP residente e uma ENTRY/NEXT BUY. São snapshots anteriores ao rollout,
não certificado de preservação posterior ou leitura direta da exchange.
Não repetir operações externas de tarefas anteriores na retomada.

Gates multi-engine, cross-shard, credential multi-IP, orçamento account-global,
admission, Watchdog, ordens/ledger/slots, idempotência e motores existentes só
recebem PASS após a evidência correspondente. Estado atual: **NÃO LIBERADO**.
