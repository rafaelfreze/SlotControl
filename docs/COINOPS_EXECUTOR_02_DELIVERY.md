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

O proprietário confirmou whitelist da API Diogo em164.90.223.159. No checkpoint
original, o cadastro apontava para01, INACTIVE/PREPARING,25slots,0ordens/posições.
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
  foi executado pelo backend com configuração temporária de hashes, autorizada
  separadamente pelo proprietário; a cobertura completa consta no checkpoint final.
  Nenhum hash/UID/key/secret deve entrar no Git, relatório ou frontend.
- Às20:44UTC, Executor01 ainda PID94831 desde18:45:28UTC;02 PID10969,
  memoryCurrent62.90MB, healthHTTPS122dcc1, drift3.5ms. Sete LIVE ACTIVE,
  reconciliações20:45:15–20:45:26, killfalse e last_errornull.
- Renovação TLS simulada em staging ACME PASS. Esse teste não comprovou uma
  renovação futura agendada nem execução do deploy-hook Nginx.
- Validação local: executor57/57; SQL efêmero serial26/26; suíte web nãoSQL603/603;
  lint, typecheck e build PASS antes da pequena adição do bootstrap de identidade.

## Checkpoint publicado — COMPROVADO

- GitHub/main e checkout local alinhados em
  `fd567fe613108c0c7e2ae7bed57cd02ed7ff7d30`.
- Control plane/web publicado na Vercel: deployment
  `dpl_6fNfjUvMk87HaExZFKg4bybzJvMM`, SHA `fd567fe`, **READY**.
- Executor02 atualizado para `fd567fe`, health **HEALTHY**, IP fixo
  `164.90.223.159`. Esse health não equivale a um Testnet E2E de trading.
- As quatro identidades Binance das contas LIVE existentes foram registradas
  pelo bootstrap server-side. A variável temporária
  `COINOPS_INITIAL_IDENTITY_BINDINGS_JSON` foi removida da configuração Vercel;
  a remoção passa a valer no runtime no próximo deploy. O deployment já publicado
  pode conservar sua configuração anterior, com bootstrap idempotente.
- Diogo foi reatribuído pelo fluxo normal autenticado da UI às
  **2026-09-26T20:57:55Z**: executor-02, IP `164.90.223.159`, conta **INACTIVE**,
  zero ordens, capital R$275 e 25 slots preservados. Não foi uma ativação.
- Executor01 manteve os sete motores LIVE existentes intactos; PID **94831**,
  sem restart, deploy ou migração das quatro contas nesta etapa.
- Coleta server-side autenticada do02 confirmada em minutos distintos no banco;
  amostra21:03:42UTC: 68 weight atual/pico, média14,63, CPU0,399%, RSS122,48MB,
  fila0, registry confere, versãofd567fe. Os sete motores01 continuavam ACTIVE
  e reconciliados em21:03:15–28UTC, sem last_error.
- SmokeADMIN autenticado confirmou os dois cards com IPs distintos. Entrega
  física de push multi-shard ainda não foi comprovada.
- Validação final do blocofd567fe: testes focados bootstrap/admissão/coletor
  11/11 e guardas Testnet13/13, lint/typecheck/build PASS. São suítes sobrepostas;
  não somar esses totais aos57/603 anteriores como testes únicos.
- A configuração Production do02 foi alinhada à versãofd567fe depois do primeiro
  deploy web. O deploy deste checkpoint documental deve incorporá-la e retirar
  a variável temporária de bootstrap; confirmar READY antes do handoff.

**COMPROVADO na UI autenticada às2026-09-26T21:01:32.184Z:** credencial de
Diogo com resultado **PASS / REAL**, executor `164.90.223.159`, whitelist
aceita, leitura e Spot habilitados, saques e transferências interna/universal
desabilitados. Executor atribuído02; SOLBRL **INACTIVE**, R$275, 25 slots e
R$11 por slot. Nenhum UID, fingerprint ou hash é registrado neste documento.
Essa validação não é um Preview ou uma ativação. **Ativação não executada.**

## Pendências neste checkpoint — NÃO TESTADO / A CONFIRMAR

- Monitoramento com Executor02 offline: **NÃO TESTADO**.
- Entrega física de push nesta etapa multi-shard: **NÃO TESTADO**.
- TestnetE2E no Executor02 com exchange real: **NÃO TESTADO**. Fixtures não substituem
  prova BUY→fill→TP→NEXTBUY→gain→reset→novo ciclo contra Binance Testnet.
- Preview e Capacity Check final de Diogo; eventual ativação somente pelo
  usuário após os gates normais. Credential PASS já conferida na UI autenticada.

O checkpoint não declara todos os gates READY. Gates não verificados não
recebem PASS. Não houve ordem artificial, alteração
de estratégia, gain, spacing, TP, NEXTBUY ou ledger financeiro nesta tarefa.
