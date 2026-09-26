# Executor 02 — evidência de implantação e checkpoint

Data: 2026-09-26. Este documento separa fatos comprovados de pendências.
Não é declaração de READY. Verificar a seção final antes de nova admissão.

## Infraestrutura criada — COMPROVADO

- DigitalOcean, Droplet603936458, `coinops-executor-02-fra1`, FRA1.
- Basic1vCPU/1GB RAM/25GB disco/1000GB transferência, US$6/mês,
  US$0,009/hora informado pelo provedor, sem adicionais pagos selecionados.
- IPv4 público fixo enquanto o Droplet existir: **164.90.223.159**.
- Ubuntu24.04.4amd64, Node24.21.0, Certbot5.8.0, Nginx, systemd.
- SSH com chave pública existente autorizada. Nenhuma private key copiada.
- HMAC novo e exclusivo gerado no VPS, env root0600, vault/estado separados.
- TLS Let's Encrypt emitido para o IPv4; expiração inicial2026-10-03.
  Timer de renovação instalado. Renovação efetiva futura não comprovada.
- Firewall22/80/443, Node escuta somente127.0.0.1:8080, SSH sem senha.

## Publicações runtime e falhas iniciais — COMPROVADO

1. `df4b38efdc689dad4cf200edb2149c0edeb25f06`: runtime isolado, bootstrap,
   scripts deploy/rollback, testes. Publicado em GitHub/main.
2. Primeiro deploy parou seguramente: main guard comparava `import.meta.url`
   (release real) com argv1 (symlink/current), sem iniciar listener. Nenhuma
   conta/ordem existia no servidor novo; Executor01 não reiniciado.
3. `8ca1c00d27f1cf53c19cba48c3450adf5606cbdf`: realpath do entrypoint,
   regressão subprocesso por symlink e import sem inicialização automática.
4. Fetch seguinte com ref abreviada/prune removeu origin/main e falhou no lock.
   Objetos Git permaneceram íntegros. Não se apagou/recriou o repositório.
5. `c1887631b565866981506733558d582b1ed7d317`: ref source completa, sem prune
   desnecessário, regressão de fetch repetido, novo commit e ancestry rollback.
   Git Windows não reproduziu a causa interna do lock anterior; a sequência
   corrigida funcionou no VPS real. Não afirmar bug de uma versão específica.
6. Deploy **HEALTHY** às20:24:05UTC; HTTPShealth às20:24:43UTC confirmou
   shard executor-02, SHA c188763, IPv4/egress164.90.223.159, BinanceOK,
   clock drift12ms, `health_scope=SHARD_INFRASTRUCTURE`,
   `account_permission=NOT_ASSIGNED`. PID10589, MemoryCurrent59.23MB.

Bootstrap/deploy obtêm código de GitHub/main por SHA explícito. Releases são
imutáveis e `/opt/coinops/current` muda atomicamente. Estado/vault/nonces ficam
fora do release. Ver `COINOPS_SHARD_DEPLOY_RUNBOOK.md`.

## Executor 01 — checkpoint de continuidade

IP46.101.104.48. Nenhum deploy/restart deste servidor foi realizado nesta
etapa. Rafael, Thyely, Caixeta e Pedro permanecem atribuídos ao executor-01.
Às20:18:30UTC, sete engines/runs atuais ACTIVE, killfalse, last_errornull,
reconciliações20:18:15–20:18:27. Runs anteriores COMPLETED preservados.
A amostra20:17:42 tinha4contas/7engines, registry conferindo, fila0,
CPU4,767%, RSS178,05MB, reconciliação máxima26,157s, errors/retries0.
Binancecurrent3241/average3272,4/peak5357: admissão01 bloqueada pela reserva,
sem bloquear trading existente. Não usar esse snapshot como autorização futura.

## Diogo e escopo autorizado

O proprietário confirmou whitelist da API Diogo em164.90.223.159. O cadastro
original ainda aponta para01, INACTIVE/PREPARING,25slots,0ordens/posições.
Não ativar pelo01 e não executar compra por terminal/SQL.
Reatribuição preparada é exceção explícita apenas para conta que nunca operou:
retirar registry INACTIVE da origem, verificar novamente ausência de histórico
financeiro/lease/reserva, mover vínculo por RPC auditado, invalidar validação
anterior, exigir nova conexão da credencial no destino. Nenhuma credencial
será copiada entre vaults; os quatro clientes LIVE não são migrados.
A ativação final será clicada pelo próprio usuário.

## Atualização do control plane e runtime

- `122dcc1836eacfd3b541904ed9ab7ccf5bc1bf3c` publicado em main e no02:
  telemetria Testnet separada. Rollback real c188763→8ca1c00 e retorno122dcc1
  HEALTHY, somente no02 vazio. Estado persistente preservado.
- Seis migrations multi-shard/ownership/staged-reassignment/capacidade por
  ambiente aplicadas com sucesso no schema coinops do backend oficial.
- HMAC02 exclusivo configurado como Secret Production da Vercel após autorização
  explícita. Validação autenticada runtime depende do deploy web abaixo.
- Acesso MCP SQL é read-only. Não ampliar grants para bootstrap de identidade.
  Vercel env run corretamente omite Secrets. O registro das quatro identidades
  será executado pelo backend com configuração temporária de hashes, autorizada
  separadamente pelo proprietário; retirar a configuração após cobertura completa.
  Nenhum hash/UID/key/secret deve entrar no Git, relatório ou frontend.
- Às20:44UTC, Executor01 ainda PID94831 desde18:45:28UTC;02 PID10969,
  memoryCurrent62.90MB, healthHTTPS122dcc1, drift3.5ms. Sete LIVE ACTIVE,
  reconciliações20:45:15–20:45:26, killfalse e last_errornull.
- Renovação TLS simulada em staging ACME PASS. Esse teste não comprovou uma
  renovação futura agendada nem execução do deploy-hook Nginx.
- Validação local: executor57/57; SQL efêmero serial26/26; suíte web nãoSQL603/603;
  lint, typecheck e build PASS antes da pequena adição do bootstrap de identidade.

## Pendências neste checkpoint — NÃO TESTADO / NÃO PUBLICADO

- Control-plane/web multi-shard ainda não publicado; bootstrap/coverage pendentes.
- Telemetria contínua autenticada e duas amostras por minuto distinto do02 no banco.
- SmokeADMIN autenticado novo card, alerta/pushmultishard e entrega física.
- Falha offline monitorada; TestnetE2E com exchange real. Fixtures não substituem
  prova BUY→fill→TP→NEXTBUY→gain→reset→novo ciclo contra Binance Testnet.
- Cadastro e credencial Diogo no Executor02, preview/capacityfinal.

Gates não verificados não recebem PASS. Não houve ordem artificial, alteração
de estratégia, gain, spacing, TP, NEXTBUY ou ledger financeiro nesta tarefa.
