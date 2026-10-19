# Retenção antirreplay e incidente do Executor 01 — 19/10/2026

## Causa comprovada

O executor gravava um arquivo SHA-256 por nonce de toda requisição autenticada,
sem rotina de expiração. Em 19/10/2026, o filesystem do Executor 01 chegou a
3.145.728/3.145.728 inodes usados, embora ainda houvesse 5,5 GB livres. O processo
continuava ativo e `/health` público respondia 200, mas a persistência do nonce
falhava antes da resolução do escopo. `/v1/state` e a telemetria autenticada
respondiam 503 `EXECUTOR_UNAVAILABLE` em poucos milissegundos.

O diretório privado de nonces continha 2.997.833 arquivos no inventário posterior
à primeira limpeza. O conteúdo amostrado era o timestamp de 13 dígitos original,
com proprietário do serviço, modo 0600, link único e datas de setembro/outubro.
Não houve evidência de falta de saldo, rejeição Binance, crash ou falta de RAM.

## Blast radius e cronologia (UTC; Cuiabá = UTC−4)

- Últimas reconciliações anteriores à falha: aproximadamente 19:13.
- Watchdog abriu incidente OFFLINE do Executor 01 às 19:16:46.
- Sete engines evoluíram para `COINOPS_LIVE_EXECUTOR_READ_STALE`, em
  `RECONCILE_ORDERS`, root `EXECUTOR_UNAVAILABLE`, quatro tentativas GET.
- Contas/mercados: Thyely BTCUSDT/SOLUSDT; Rafael BTCBRL/SOLBRL;
  Caixeta BTCBRL/SOLBRL; Pedro SOLBRL. Os nove motores de 02/03 continuaram saudáveis.
- 19:34:37–19:35:22: manutenção emergencial sob flock removeu exatamente
  15.644 arquivos de nonce comprovadamente expirados há mais de uma hora.
  Outros 22 itens lidos foram preservados. Nenhum arquivo financeiro foi removido.
- 19:35:21–19:35:44: o cron oficial executou `VERIFIED_READ_RECOVERY`, sob os
  leases e provas financeiras existentes, sem RESUME manual nem SQL de liberação.
- 19:35:46: Watchdog confirmou 16 HEALTHY, três shards HEALTHY, zero incidentes
  abertos; os sete incidentes financeiros e o incidente de infraestrutura
  ficaram `RECOVERED`, com ações e timestamps persistidos.
- 19:40:31–19:40:38: observação autenticada Binance × ledger, por engine/run,
  confirmou 60 ordens residentes correspondentes por orderId/clientOrderId,
  side, símbolo, quantidade e preço: 53 TPs e sete NEXT BUY. Cada run manteve
  seus 25 slots. Não foram criadas/canceladas ordens para testar.

Incidente raiz de infraestrutura: `6ca09e5f-b8e7-46d9-96cd-7910f637c6a1`.
O Watchdog detectou corretamente; não poderia reparar inodes por meio de um
executor cuja autenticação não conseguia persistir. Restaurado o armazenamento,
o reconciliador normal já tinha a recuperação determinística necessária.

## Invariantes da correção

`src/nonce-retention.mjs` é manutenção de cache, não parte da Strategy Engine.
Não importa o servidor, não recebe credenciais e não acessa Binance/Supabase.
Default é dry-run. Apply exige Linux e prova do flock exclusivo herdado pelo
descritor, no kernel, em arquivo privado fora do diretório de nonces.

Somente `<state>/nonces/<sha256 minúsculo>` pode ser removido, após confirmar:

- diretórios reais e privados, sem componentes symlink;
- arquivo regular, 0600, UID exato, tamanho 13 e link único;
- bytes de timestamp estritamente válidos e tanto timestamp quanto mtime
  anteriores ao início do lote menos uma hora;
- identidade/dev/inode/mtime/ctime inalterados antes do unlink;
- relógio sem regressão e orçamento de trabalho respeitado.

Nonce recente, futuro, malformado, symlink, hardlink, nome desconhecido e
subdiretório são preservados. A assinatura continua aceitando somente a janela
original de ±30 segundos; a manutenção não amplia nem desliga a proteção.

`.pending`, `.json` financeiros, claims, journals, vaults, registry, env, saldos,
ordens, slots e leases não têm retenção derivada deste mecanismo. Uma resposta
incerta de trading continua fail-closed. Nenhuma estratégia ou parâmetro muda.

## Operação permanente

Os assets de manutenção são publicados pelo GitHub/main em release própria,
separada do runtime financeiro. A instalação não reinicia o executor e verifica
PID/início do serviço antes e depois. Não é necessário modificar o manifest do
runtime, schema, RLS, cron Vercel ou política de notificações.

A unidade de manutenção roda com o UID do executor, sem rede nem EnvironmentFile,
sem acesso às credenciais, com filesystem somente leitura salvo nonces e seu
diretório privado de lock. Flock impede cleaners concorrentes; prioridade baixa
e lotes limitados preservam capacidade do trading. A varredura completa avança
com o mesmo iterador entre lotes, em vez de reiniciar sempre pelo primeiro
prefixo e deixar arquivos antigos fora do alcance.

Antes de instalar, executar os testes offline em diretórios descartáveis, com
rede e diretórios operacionais inacessíveis. Validar replay recente, expiração,
malformados, links, clock rollback, concorrência, idempotência, progresso de
varredura e preservação de claims financeiros. Não executar teste de ordem LIVE.

Instalação: executar `bash install-nonce-retention.sh <SHA completo revisado em
main>` separadamente, primeiro no shard afetado e depois nos demais. O SHA de
manutenção é independente do target do runtime financeiro. O instalador imprime
fingerprint dos seis assets públicos, PID e início monotônico preservados.
Os deploys financeiros futuros aceitam `MAINTENANCE_MAIN_SHA` opcional quando
esses dois SHAs diferirem. Não usar um deploy financeiro apenas para instalar GC.

Validação desta correção: 51 testes direcionados locais PASS (seis verificações
de kernel Linux não executáveis no Windows), e 27/27 fixtures Linux PASS, sem
skips, em unidade transitória sem rede e sem acesso a `/etc/coinops` nem ao
diretório de estado LIVE. Os fixtures usam somente HMAC fictícia e diretórios
descartáveis. Sintaxe Bash, fronteiras do bundle e fingerprint do runtime foram
verificados. A aplicação web e o schema não são alterados pela correção.

## Runbook de reincidência

1. Confirmar Watchdog, engine/shard exatos e se há recuperação saudável.
2. Conferir `df -i` além de `df -h`; PID ativo e health público não bastam.
3. Conferir serviço/timer de retenção, release/hash e saída sanitizada de progresso.
4. Não apagar outro estado para ganhar espaço. Não reiniciar cegamente.
5. Se o armazenamento é a causa comprovada, usar apenas o helper oficial sob
   flock e os limites documentados. Falha de permissão, identidade, relógio ou
   formato exige investigação; não adicionar bypass.
6. Confirmar health **autenticado** e deixar o cron reconciliar sob lease/CAS.
7. Conferir Binance × ledger × engine, TPs, NEXT BUY, slots, freshness e fechamento
   auditado no Watchdog. Não resolver incidentes/gates manualmente.
8. Se o cache volta a crescer sem retenção, tratar como regressão operacional da
   instalação/manutenção, não como incidente normal de gain ou fill.
