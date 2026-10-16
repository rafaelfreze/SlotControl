# Validação de credencial já instalada em outro executor

## Escopo e autorização

Em 16/10/2026 o proprietário autorizou expressamente reutilizar **somente a
credencial Thyely do Executor 01 no Executor 03**, preservando a origem e os IPs
anteriores. Isso não cria exportação genérica de credenciais nem autorização
permanente para copiar vaults, HMACs, private keys, registries ou estado financeiro.
Uma eventual transferência operacional precisa de transporte autenticado e
criptografado, recriptografia pela chave exclusiva do destino e prova de identidade
Binance/whitelist no IP de destino, sem revelar segredo ao navegador, logs ou chat.

## Causa e correção do cadastro

O botão **Validar conexões já configuradas · sem ordens** envia
`REVALIDATE_SHARD`. O servidor anteriormente recusava essa ação quando ainda não
existia conexão no banco nem engine no destino, mesmo que o vault já contivesse a
credencial canônica instalada. Não se deve contornar isso inserindo uma conexão
`VALIDATED` manualmente.

O mesmo fluxo passa a poder descobrir uma credencial já instalada, com estas
fronteiras:

1. ADMIN autenticado, mesma origem, operador/tenant ativos e conta pertencente ao
   operador; nenhuma alegação de ownership enviada pelo navegador é aceita.
2. Shard configurado no servidor, habilitado no registry, IP exatamente coincidente
   e referência `account_<UUID sem hífens>` canônica da conta.
3. Sem conexão nem engine prévios no shard, `preview_executor_admission(+1)` deve
   retornar `CAPACITY_OK` antes da consulta de credencial. Essa consulta não reserva
   capacidade e não certifica a topologia ou ativação de um novo engine.
4. O destino executa `REVALIDATE` pelo endpoint autenticado existente. Só lê Binance
   para confirmar identidade, permissões e whitelist; não recebe nem exporta chaves.
   Ausência de credencial no vault falha fechada.
5. A resposta deve comprovar escopo, shard, IP e permissões exatos e frescor de até
   30 segundos. O hash UID fica server-side; `claimAccountIdentity` precisa confirmar
   o mesmo dono global antes do upsert da conexão e da auditoria idempotente.
6. Somente após a prova a conexão fica `VALIDATED`. Falha de UID, IP, permissão,
   vault ou provider não gera nova conexão validada.

Revalidação de conexão/engine já existentes continua independente da capacidade
para novos motores. Engine routing, bootstrap da conta, capital, ordens, slots e
estratégias não são alterados por esse caminho. A ativação futura continua sujeita
a todos os seus gates, inclusive capacidade correspondente à quantidade de slots.

## Validação isolada

Testes de candidato/resolver cobrem descoberta admitida, capacidade ausente ou
negada, erro do provider de capacidade, revalidação existente sem consulta de
admissão, referência estrangeira, shard desabilitado e IP divergente. Os testes de
prova e política mantêm rejeição de escopo/frescor/permissões e ausência de secrets
na resposta. Nenhuma consulta ou mutação LIVE é usada nesses testes.

## Operação autorizada executada

Em 16/10/2026, 16:53:38Z, a transferência Thyely 01→03 concluiu com
`PASS`: UID e credencial exatos, IP de saída `167.71.37.166`, whitelist e
permissões aceitos. O cofre do 03 confirmou por decriptação local o conteúdo
gravado, sob o usuário do serviço. O cofre do 01 não foi modificado. Nenhuma
ordem foi enviada. A primeira tentativa não gravou o destino: o documento
legado da origem não possuía `credential_hash`; a validação fresca passou a
comprovar esse hash sem regravar a origem, mantendo UID/fingerprint exatos.

O procedimento explícito está em
`tools/operations/reuse-thyely-credential-executor03.mjs`; não é executado pelo
runtime, cron ou navegador. O 03 gera uma chave RSA3072 efêmera em RAM, o 01
cifra a credencial com AES256-GCM/OAEP-SHA256, e ambos usam SSH com host keys
conhecidas. O notebook só recebe ciphertext. Nonce, escopo, direção, IPs e
validade de 90 segundos ficam autenticados. A gravação usa o vault oficial,
`replace:false`, lock e leitura de confirmação; nenhuma chave privada, HMAC,
arquivo de vault ou estado financeiro é copiado. Erros não expõem stderr ou
secrets. Repetição exige recuperar metadados primeiro.

Esta evidência confirma a instalação, não cria engine, não registra conexão
validada no control plane e não certifica carga de 100 slots. O registro pelo
fluxo oficial e todos os gates de ativação permanecem separados.
