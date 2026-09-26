# CoinOps — provisionamento e deploy de novos shards

Este runbook serve exclusivamente para `executor-02` e posteriores. Os scripts rejeitam `executor-01`, seu IPv4 `46.101.104.48` e o checkout legado `/opt/coinops/source`. Não copiar env, vault, registry, leases ou estado do Executor 01. Nenhum comando abaixo migra contas, altera ledger ou envia ordens.

## Contrato

- Ubuntu 24.04 LTS amd64, Node 24.21.0, Certbot 5.8.0, Nginx e systemd.
- Uma conta Binance tem exatamente um shard primário. HMAC/vault exclusivos por servidor; a chave nunca aparece em Git, comandos públicos ou saída dos scripts.
- GitHub/main é a fonte oficial. Deploy aceita somente SHA completo de 40 caracteres pertencente ao histórico de main; rollback usa outro SHA já revisado com suporte a shards.
- IPv4 do servidor precisa ser o mesmo observado no egress. Não há rotação de IP nem rebalanceamento de conta LIVE. Destruir/recriar um Droplet pode alterar seu IPv4: não recriar infraestrutura com contas vinculadas.
- O control plane mantém scheduler, ledger, admission e encaminhamento explícito por shard. O executor não recebe credenciais Supabase nem administra contas de outro shard.

## Provisionamento

Provisionar somente o recurso explicitamente autorizado no provedor oficial, com chave SSH pública previamente autorizada. Não copiar chave privada para o VPS. Confirmar região, tamanho, custo, IPv4 e que o servidor está vazio. Manter Executor 01 intocado.

Obter os assets deste diretório a partir do SHA revisado de GitHub/main; não usar scripts particulares de um PC. O bootstrap exige os templates adjacentes do mesmo SHA. Executar como root no novo servidor:

```bash
bash apps/live-executor/deploy/bootstrap-new-shard.sh executor-02 NOVO_IPV4 fra1 EMAIL_ACME
```

O bootstrap valida host/shard/egress antes de mudanças, instala runtime fixado com verificação SHA256 do download oficial, gera HMAC local de 48 bytes aleatórios somente se ausente, cria env root:root 0600, registry root:coinops-executor 0640, estado coinops-executor 0700, serviço restrito, SSH sem senha e firewall 22/80/443. Não guarda credencial Binance. Uma repetição no mesmo shard preserva HMAC, registry e estado; não executá-la como rotina de atualização.

As flags globais são `TRADING_ENABLED=true`/`KILL_SWITCH=OFF`, mas registry vazio e credenciais ausentes não autorizam nenhuma ordem. Cada engine precisa cumprir os gates de credencial, escopo, capital, preview, capacidade, ativação e reconciliação. O executor inicial deve permanecer com zero contas e motores.

TLS usa certificado Let's Encrypt do IPv4, perfil `shortlived`, sem fallback para perfil diferente. O timer renova duas vezes ao dia e recarrega Nginx. Porta Node fica em `127.0.0.1:8080`. Health vazio é infraestrutura (`NOT_ASSIGNED`), não validação de credenciais de futuras contas.

## Deploy por SHA

```bash
bash apps/live-executor/deploy/deploy-shard.sh executor-02 SHA_COMPLETO_REVISADO
```

O script mantém espelho Git sem credenciais em `/opt/coinops/repository.git`, extrai somente executor e dependências locais da Strategy Engine para `/opt/coinops/releases/SHA`, valida imports e muda atomicamente `/opt/coinops/current`. O estado permanece fora do release. Atualiza somente a versão no env; nenhum secret é trocado. Um lock de deploy impede execução simultânea.

O health exige shard, SHA e IPv4 corretos. Se falhar, retorna ao release anterior e reinicia somente este servidor; no primeiro deploy malsucedido o serviço é parado, sem apagar estado. Uma repetição do mesmo SHA ativo não reinicia o serviço. Nunca fazer rollback para commit anterior à implementação multi-shard.

## Health, logs e restart

```bash
systemctl status coinops-live-executor --no-pager
curl --fail https://NOVO_IPV4/health
journalctl -u coinops-live-executor --since '10 minutes ago' --no-pager
systemctl list-timers coinops-certbot-renew.timer --no-pager
/opt/coinops-certbot/bin/certbot renew --dry-run
systemctl restart coinops-live-executor
```

Validar health novamente após restart. Nunca exibir o env, vault, headers assinados ou key files. O monitor deve confirmar telemetria assinada recente e IDs de engines/contas exatos, não apenas HTTP 200. O bootstrap não ativa admissão no control plane: registrar endpoint/HMAC em configuração server-side autorizada e shard no banco via migration/fluxo versionado separado, mantendo admissão fail-closed até validação.

`/v1/capacity` preserva o contrato REAL no nível superior e publica `environments.TESTNET` separadamente. Cada ambiente observa exclusivamente o header de peso de seu próprio host Binance; quando o tráfego está ocioso, consulta pública `/api/v3/time` no máximo uma vez por minuto/ambiente, sem credenciais nem ordens. CPU/RAM são recursos compartilhados do servidor, não duplicação de orçamento Binance. Falha da amostra Testnet não invalida a amostra LIVE e ausência de header permanece desconhecida.

O registry de ordens do executor é REAL. Testnet usa `registry_scope=CREDENTIAL_BOUND_TRANSPORT`: informa somente `credential_account_ids` lidos dos metadados locais, sem decriptação, UID, fingerprint ou secret. O control plane cruza a atribuição única de cada conta e calcula engines/contas ativos pelo ledger/run Testnet; credenciais staged/inativas podem ser um superset. Não inventar `engine_ids` ou contagem local Testnet. Inventário corrompido/ausente bloqueia nova admissão Testnet, não os motores LIVE existentes.

As flags globais explícitas do executor também bloqueiam `POST`/`DELETE` financeiro Testnet em `/api/v3/order`: exigem `TRADING_ENABLED=true` e `KILL_SWITCH=OFF`. GETs de diagnóstico e `/api/v3/order/test` (não cria ordem) permanecem disponíveis. Falha de engine não altera essas flags globais; o bloqueio individual continua no control plane. Isso não altera o contrato de cancelamento protetor LIVE.

## Rollback

Executar o mesmo script de deploy com o SHA anterior compatível, registrado na evidência de release. Isso preserva registry, vault, nonces e claims de idempotência. Não restaurar snapshots antigos de estado financeiro. Após rollback, confirmar health/versão, reconciliação de cada conta do shard, ausência de duplicação, logs e que outros shards permaneceram operacionais.

Antes de haver contas, testar falha/restart/deploy/rollback do Executor 02 e assinatura cruzada negada. Depois de haver contas, testes destrutivos ficam proibidos; qualquer manutenção segue procedimento de continuidade e recovery normal.

## Referências oficiais dos instaladores

- Node 24.21.0: https://nodejs.org/download/release/v24.21.0/
- Certbot 5.8.0, certificados IP e perfil exigido: https://eff-certbot.readthedocs.io/en/stable/using.html

Scripts/testes locais não constituem prova de provisionamento, TLS emitido, deploy, rollback real ou Testnet E2E. Registrar essas evidências depois de executadas no destino correto.
