# Paridade dos executores e aporte na NEXT BUY

## Regra financeira comum

Uma BUY/ENTRY `NEW`, sem qualquer fill, não é uma posição OPEN. Após aporte APPLIED comprovado, o reconciliador oficial pode cancelar essa BUY com `ONLY_NEW` e criar a revisão idempotente com quantidade atualizada, mantendo preço e prioridade da Strategy Engine. Exige saldo, filtros, caps sincronizados, identidade e operação exatas. Se houver fill concorrente, o fill vence: reconciliar e proteger, nunca complementar por MARKET.

Uma compra executada é posição OPEN, mesmo que a tela ainda diga entrada. A ordem residente passa a ser SELL/TP: seu aporte permanece PENDING até encerramento normal. Não aumentar quantidade, entry, TP ou gain retroativamente. Não reaplicar aporte para testar paridade. Ver `COINOPS_NEXT_BUY_CAPITAL_REFRESH.md`.

## Causa da lacuna de publicação

Os scripts validavam cada host, mas não havia alvo de release comum nem verificação final de todos os shards. Assim, duas versões diferentes poderiam satisfazer configurações individuais. `actual_executor_version` é uma declaração do processo, não prova dos bytes publicados.

A correção fica na camada de publicação/read-only, sem mudar Strategy Engine, Watchdog, Capacity Manager, credenciais ou ordens. `fleet-release.json` define um único alvo revisado, Node, contrato e fingerprint. `fleet-parity.mjs` compara os arquivos públicos com os blobs Git, descobre os shards habilitados no schema coinops do Supabase oficial e exige evidência de cada host via SSH autenticado com host key conhecida. Não consulta histórico Binance, não chama endpoint financeiro, não escreve no host nem inicia servidor.

## Fluxo obrigatório para qualquer alteração de executor

1. Preservar working tree e publicar o código revisado em GitHub/main. Registrar rollback compatível. Não declarar esse primeiro commit como rollout concluído.
2. Atualizar o manifest em um segundo commit revisado com o SHA completo de runtime já existente em main e seu fingerprint calculado pelo helper. Isso evita autorreferência de hash. Mudanças só no frontend não mudam a release de runtime.
3. Validar `node apps/live-executor/deploy/fleet-parity.mjs --check-code`. Manter a janela temporária de versões explícita, limitada e autorizada. Não alargar allowlist para contornar falha.
4. Usar assets de deploy do main revisado, incluindo manifest/helper/preflight juntos. Os scripts rejeitam SHA diferente do alvo comum antes de alterar host. Atualizar um shard por vez e confirmar health/reconciliation, sem mover contas. Rollback interno para versão anterior preserva a proteção existente; rollback planejado demanda alvo revisado compatível.
5. Executar `node apps/live-executor/deploy/fleet-parity.mjs --verify`. Fornecer ambiente Supabase server-side oficial e caminho de chave SSH pelo mecanismo documentado no CLI; nunca copiar valores em comandos, Git ou logs. A lista de destinos vem do registry, não de uma lista fixa de IPs.
6. Somente `FLEET_PARITY_PASS` de TODOS os habilitados conclui publicação. Ausência, stale, divergência de hash/SHA/Node/identidade é falha, não saúde presumida. Interromper fechamento, investigar e preservar motores saudáveis. Não transformar falha de auditoria em desligamento do trading.

Novo shard deve receber exatamente o mesmo alvo antes de onboarding e será incluído automaticamente no próximo verify. Bootstrap isolado não significa pronto. Identidades, IPs, vaults, quotas e limites por conta continuam distintos por desenho; layout legado vs releases também pode diferir sem criar regras financeiras distintas.

### Comandos e ambiente

O verificador usa somente `NEXT_PUBLIC_SUPABASE_URL` (ou `SUPABASE_URL`), `SUPABASE_DATA_SCHEMA=coinops` e `SUPABASE_SERVICE_ROLE_KEY` no processo local/control plane. Não instala nem transfere essas variáveis para o VPS. Pode receber `COINOPS_FLEET_SSH_KEY`/`COINOPS_FLEET_SSH_USER` ou `--ssh-key`/`--ssh-user`; somente o caminho da chave, nunca o conteúdo. Host keys desconhecidas falham; não usar StrictHostKeyChecking=no. A chave existente precisa de acesso aos metadados do serviço/processo, somente leitura pelo probe, sem imprimir environment.

```text
node apps/live-executor/deploy/fleet-parity.mjs --check-target SHA_COMPLETO
node apps/live-executor/deploy/fleet-parity.mjs --check-code
node apps/live-executor/deploy/fleet-parity.mjs --verify --ssh-key CAMINHO_DA_CHAVE_EXISTENTE
```

Os comandos recebem ambiente backend já configurado. Resultado JSON pode ser conservado como evidência mínima (somente identificadores públicos, hashes e health); não imprimir variáveis ou arquivos de secrets. O probe exige evidência até 120s e health até 45s, verifica processo antes/depois, UID não-root e identidade do binário. Arquivo alterado após o início do processo impede prova do código carregado. Falta de evidência nunca autoriza restart para obter PASS.

## Evidência real — 28/09/2026

Às 13:04Z (09:04 em Cuiabá), ambos os hosts oficiais estavam ativos no runtime `89ce0d3237f7c2509acd9c87958ba4dbb6bf3f63`, Node `v24.21.0`, UID/GID `coinops-executor`, `ProtectSystem=strict`, `NoNewPrivileges=yes`, `PrivateTmp=yes`. Os nove arquivos de `apps/live-executor/src` tinham hashes iguais entre hosts. O verificador completo acrescenta grafo de dependências e comparação ao Git, não apenas comparação entre hosts.

Dete/SOLBRL: aporte único de R$5.000 às 11:43:02Z, slots #1–#5. #1 e #2 já tinham posições OPEN antes desse horário; suas parcelas de R$1.000 ficaram PENDING. #3–#5 receberam APPLIED. O preset `1 aberto + 4 abaixo` exigia uma âncora OPEN, não proibia outra OPEN nas quatro posições seguintes; isso não criou uma compra adicional.

Evento `NEXT_BUY_CAPITAL_REFRESH_CONFIRMED`, slot #3, 11:43:34.665565Z: BUY anterior 0,018 SOL cancelada com execução zero; nova BUY 1,683 SOL, mesmo preço R$600,40, notional R$1.010,4732 para capital de slot R$1.011,00 (arredondamento Binance). Fluxo server-side já realizou o resize no Executor 02. Não repetir essa ação.

Nenhum aporte, ordem, cancelamento manual, posição ou capital foi alterado para esta auditoria. Não houve restart de executores para validar a proteção de publicação. Os testes usam fixtures locais.

### Fechamento comprovado

- 13:20:37.623Z: `FLEET_PARITY_PASS`, 2/2 executores; 21 arquivos transitivos idênticos ao Git oficial, fingerprint `6e26f78dc3bf0e30753f78920f87216426786067770ae528c411e52f0f697821`. Código em disco anterior ao início de ambos os processos; PID e metadados estáveis durante coleta. Evidência mínima: `docs/evidence/coinops-fleet-parity-20260928.json`.
- Às 13:15Z, os 11 motores estavam ACTIVE, sem last_error/kill switch e reconciliation entre 17–28s. Nenhuma mutação financeira ou restart nesta tarefa.
- 104 testes direcionados PASS: 43 aporte/Strategy Engine/relatórios, 40 transporte/isolamento (incluindo 5 regressões novas SOLUSDT no executor-03 fictício), 6 deploy/preflight/rollback e 15 fleet. Sintaxe Node/shell e diff check PASS. Sem alteração em runtime, web, schema ou RLS; build Next.js e smoke de UI não aplicáveis.
- O arquivo de ambiente local existente continha placeholders e foi corretamente recusado pelo gate de projeto. Não substituir secrets nem reduzir guard: o smoke real usou registry pelo conector Supabase oficial (relido ao final), seguido dos mesmos exports de sondagem SSH e avaliação. A descoberta GET do CLI foi validada por fixtures, não autenticada com aquele arquivo local inválido.

## Limites

O guard evita concluir uma publicação desigual pelos scripts oficiais; não é auto-deploy e não garante ausência de qualquer falha futura. Um operador com acesso root pode contornar scripts, por isso usar somente main/runbook e repetir a verificação no fechamento de cada rollout. A checagem de paridade não substitui reconciliação financeira nem confirma entrega de alertas. Layout/IP/configuração privada distinta não é divergência de regra.
