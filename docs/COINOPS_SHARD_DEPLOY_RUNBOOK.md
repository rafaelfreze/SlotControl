# CoinOps — provisionamento e deploy de novos shards

O provisionamento e `deploy-shard.sh` servem exclusivamente para `executor-02` e posteriores e rejeitam `executor-01`, seu IPv4 `46.101.104.48` e o checkout legado `/opt/coinops/source`. A seção de deploy legado abaixo usa outro script, exclusivo para esse checkout existente. Não copiar env, vault, registry, leases ou estado entre executores. Nenhum comando abaixo migra contas, altera ledger ou envia ordens.

## Contrato

- Ubuntu 24.04 LTS amd64, Node 24.21.0, Certbot 5.8.0, Nginx e systemd.
- Uma conta Binance tem exatamente um shard primário. HMAC/vault exclusivos por servidor; a chave nunca aparece em Git, comandos públicos ou saída dos scripts.
- GitHub/main é a fonte oficial. Deploy aceita somente SHA completo de 40 caracteres pertencente ao histórico de main; rollback usa outro SHA já revisado com suporte a shards.
- IPv4 do servidor precisa ser o mesmo observado no egress. Não há rotação de IP nem rebalanceamento de conta LIVE. Destruir/recriar um Droplet pode alterar seu IPv4: não recriar infraestrutura com contas vinculadas.
- O control plane mantém scheduler, ledger, admission e encaminhamento explícito por shard. O executor não recebe credenciais Supabase nem administra contas de outro shard.
- O catálogo ADMIN de Estratégia pagina todas as contas do operador e usa `exchange_accounts.onboarding_environment` para exibir contas recém-atribuídas, mesmo antes da validação da API. Selecionar `account_id` consulta somente os motores e checks dessa conta; o backend resolve `executor_shard_id` e o IP sem escolha manual do usuário. Aparecer no seletor **não** significa credencial validada: preview/preparação exigem `BINANCE_CREDENTIAL PASS` no mesmo ambiente, e ativação mantém os gates de capacidade e trading. Após salvar credenciais em Configurações, reabrir Estratégia atualiza o estado. Nunca habilitar motores a partir do registro `EXECUTOR_ASSIGNMENT` sozinho.

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

O SHA deve coincidir com o alvo comum de `apps/live-executor/deploy/fleet-release.json`. Obter os scripts, manifest e helper `fleet-parity.mjs` juntos do main revisado, mesmo quando o runtime alvo não mudou. Ambos os scripts rejeitam um alvo diferente antes de alterar host. `DEPLOY_HEALTHY`/`ALREADY_DEPLOYED` é evidência individual: somente `fleet-parity.mjs --check-code` e `--verify`, sobre TODOS os shards enabled do registry oficial, permitem encerrar a publicação. Novos executores seguem a mesma regra antes do onboarding. Procedimento e limites em `COINOPS_EXECUTOR_FLEET_PARITY.md`.

```bash
bash apps/live-executor/deploy/deploy-shard.sh executor-02 SHA_COMPLETO_REVISADO
```

O script mantém espelho Git sem credenciais em `/opt/coinops/repository.git`, extrai somente executor e dependências locais da Strategy Engine para `/opt/coinops/releases/SHA`, valida imports e muda atomicamente `/opt/coinops/current`. O estado permanece fora do release. Atualiza somente a versão no env; nenhum secret é trocado. Um lock de deploy impede execução simultânea.

O health exige shard, SHA e IPv4 corretos. Se falhar, retorna ao release anterior e reinicia somente este servidor; no primeiro deploy malsucedido o serviço é parado, sem apagar estado. Uma repetição do mesmo SHA ativo não reinicia o serviço. Nunca fazer rollback para commit anterior à implementação multi-shard.
`ALREADY_DEPLOYED` exige também a versão correta no env e health observado com
shard/SHA/IP exatos; symlink correto e `systemctl is-active` sozinhos não bastam.
`DEPLOY_FAILED_ROLLED_BACK` só é emitido depois de confirmar o health da versão
anterior. Se restart ou health do rollback falhar, o script termina com erro
específico, sem declarar recuperação concluída.

### Preflight obrigatório com a identidade do serviço

`runtime-preflight.sh` consulta `User`, `Group`, `WorkingDirectory` e `ExecStart`
do systemd, rejeita root e executa via `runuser` uma verificação de leitura de
todos os arquivos de runtime e import do servidor, sem iniciar listener e com
ambiente vazio. Root conseguir importar **não** comprova acesso pelo serviço.
Staging, release final e rollback passam por essa verificação antes do restart.
Código público usa `umask 022`/permissão de leitura; env root:root 0600, vault,
registry, idempotência, leases e estado persistente não têm permissões ampliadas.
Manter o helper adjacente ao script e obter ambos do SHA revisado de main.

### Executor 01 — checkout legado existente

```bash
bash apps/live-executor/deploy/deploy-legacy.sh SHA_COMPLETO_REVISADO
```

Esse script exige `/opt/coinops/source`, ausência do layout `/current`, origem
oficial, working tree limpa, IP estabelecido e shard ausente (default legado 01)
ou explicitamente 01. Exige SHA completo pertencente a main e avanço fast-forward.
Antes do merge, valida archive do candidato e runtime anterior como usuário do
serviço. Merge e eventual rollback usam `umask 022`; leitura é normalizada somente
nos arquivos rastreados de runtime, nunca recursivamente no checkout inteiro.
Só `COINOPS_EXECUTOR_VERSION` é alterada no env, verificando hash das demais linhas.
Após falha, `git switch --detach` para o SHA anterior recusa árvore suja, repete
preflight e verifica health; não usa reset/force nem restaura estado financeiro.
O próximo avanço pode partir desse HEAD detached. Mesmo SHA ativo/saudável não
reinicia. Stagings públicos de preflight são preservados para inspeção e limpeza
operacional controlada; não contêm env, vault ou estado.

Incidente observado em 2026-09-28: durante esta manutenção, um deploy manual do
Executor 01 executado como root com `umask 077` criou três arquivos públicos de
código em modo 0600. O serviço não-root falhou com EACCES; o primeiro rollback
repetiu a permissão e não recuperou. Normalizar a leitura desses arquivos e
reiniciar restaurou o serviço. A causa foi o procedimento desta execução, não
gain, aporte, Binance ou Strategy Engine. A correção permanente acima elimina o
critério inadequado de “import como root passou” e cobre também rollback e shards
futuros. Testes locais/static não substituem prova do UID/GID real no servidor.

### Janela de compatibilidade revisada

Somente após autorização explícita, preparar a aceitação temporária da versão
atual e da nova versão revisada. Não modificar/copiar JSON com secrets para isso.
Manter a versão atual única em `validatedVersion` do shard (ou
`LIVE_EXECUTOR_VALIDATED_VERSION` no Executor 01), e configurar somente:

- `COINOPS_EXECUTOR_XX_NEXT_VALIDATED_VERSION`: nova versão exata revisada;
- `COINOPS_EXECUTOR_XX_VERSION_TRANSITION_START`: início UTC ISO, inclusivo;
- `COINOPS_EXECUTOR_XX_VERSION_TRANSITION_UNTIL`: fim UTC ISO, exclusivo.

Substituir `EXECUTOR_XX` pelo shard real. Datas exigem `Z`, com segundos e
milissegundos opcionais (três dígitos). A janela deve durar mais de zero e no
máximo seis horas; usar a menor janela operacional suficiente. Antes do início
somente a antiga é aceita; durante a janela somente antiga/nova; no instante
exato do fim e depois **somente a nova**, mesmo em instâncias web já em execução.
O gate é recalculado por request; restart/redeploy não prolonga a exceção.
Configuração incompleta, inválida ou NEXT com múltiplas versões falha fechada
apenas no shard correspondente. Uma lista direta de duas versões também exige
START/UNTIL e usa a primeira como antiga e a segunda como nova; não combiná-la
com NEXT. Não há aceitação indefinida de duas versões.

Cada versão conserva o limite de 100 caracteres e o alfabeto `a-zA-Z0-9._-`;
espaços, entradas vazias, repetidas, wildcard e listas maiores são rejeitados.
O banner legado e o health por engine usam o mesmo gate. Quando o executor
publica `actual_executor_version`, esse é o release conferido; `version` é
fallback apenas quando o campo está ausente, nunca um bypass por alias legado.
No health autenticado `/v1/health`, `version` e `actual_executor_version` (quando
presente) precisam coincidir; só o GET legado admite alias diferente. Se o painel
mostrar shard HEALTHY mas engine sem confirmação, comparar o health autenticado
daquele engine com a janela/versões exatas e todos os demais gates. Health de
infraestrutura, Watchdog verde ou reconciliação recente não substituem essa prova.

Publicar a web com a janela, validar o estado atual e atualizar um executor por
vez pelo SHA revisado; confirmar health exato, reconciliação e isolamento antes
do próximo. Registrar evidência do fechamento novo-only no fim. Na próxima
configuração/rollout, promover a nova versão à base e remover NEXT/START/UNTIL
juntos; nunca remover somente NEXT. Depois do cutoff, rollback para a antiga
exige nova decisão explícita de versão, não reabrir a janela silenciosamente.
Nenhum passo muda IP/HMAC/credenciais, permissões, flags, caps ou guardas
financeiros; capacidades novas continuam exigindo suporte explícito do executor.

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
