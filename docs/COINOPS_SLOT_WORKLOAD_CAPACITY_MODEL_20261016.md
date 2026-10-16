# CoinOps — slots, motores, ordens e capacidade de execução

Produto CoinOps; código SlotControl/main; projeto `otdfpmsegjxpqrzisfmi`,
schema `coinops`. Este documento diferencia o modelo vigente da proposta futura.
**Não é certificado de carga, migration aplicada ou autorização para contornar o gate.**

## Quatro grandezas independentes

| Grandeza | Significado | Fonte/gate |
| --- | --- | --- |
| Motor | Estratégia e identidade independente, com shard imutável | `trading_engines.id` |
| Slots | Oportunidades físicas de posição desse motor | `trading_engines.slot_count`, não contagem de linhas |
| Ordens residentes | Até um TP por slot e uma NEXT BUY por motor | Binance por conta/par, soma entre shards |
| Request weight | Trabalho REST por IP, inclusive leituras/retries | Telemetria + perfil exato de workload |

Um motor de100slots não representa quatro motores, nem autoriza100BUY simultâneas.
Uma resposta saudável de capacity ou um preview de saldo também não prova o
perfil de carga de uma quantidade nova. Os gates são cumulativos.

| Novo motor | Slots físicos | NEXT BUY máxima | Reserva residente N+1 | Total account-wide com dois motores25 existentes |
| --- | ---: | ---: | ---: | ---: |
|25|25|1|26|78|
|50|50|1|51|103|
|100|100|1|101|153|

Na Thyely, os irmãos BTCUSDT/SOLUSDT não somam sua reserva ao limite **do par**
SOLBRL, mas contam no limite exchange/account-wide quando esse filtro existir.
Ordens externas e reservas de dispatch pendentes são adicionais. Exemplo:
dois motores100 no mesmo par exigem202residentes; um filtro200 deve negar essa
capacidade mesmo quando os dois estiverem momentaneamente com poucas posições.
O SQL e o projetor account-global já usam a soma canônica N+1, sem misturar IPs,
quotes ou namespaces. Fonte: migration `20261016161550` e
`apps/web/lib/execution/account-order-budget.ts`.

## Política vigente: o que é conservador e o que não é saturação

`executor_capacity_policy()`/`preview_executor_admission` continuam canônicos:

```
projeção = média dos máximos por minuto (15min)
         + admissões pendentes ainda não observadas
         + incremento conservador do plano novo
teto =3900/min (65% de6000); headroom de recovery =2100/min (35%)
```

Os2100 já são reservados uma única vez pelo teto3900. Não se subtrai2100 do
teto novamente nem se concede esse valor individualmente a cada engine. O perfil
deve explicitar leituras, criação/reconciliação e retries do seu envelope; remover
503 do bound e atribuí-lo ao recovery dos irmãos sem uma prova agregada é inseguro.

Motores25 usam o incremento legado900, explicitamente
`CONSERVATIVE_UNCALIBRATED`, não um p95 medido. N diferente de25 exige perfil
exato. No contratoV1, `capacity_units` é inteiro e cada unidade reserva900:

| Bound hipotético do perfil | Unidades mínimas V1 | Reserva V1 | Arredondamento adicional |
| --- | ---: | ---: | ---: |
|900|1|900|0|
|1750|2|1800|50|
|2600|3|2700|100|
|2700|3|2700|0|
|2807|4|3600|793|
|2816|4|3600|784|

Esses valores exemplificam a regra, **não certificam25/50/100**. Um trace2816
não pode ser declarado menor ou igual a2700. Também não é um upper bound só por
ser uma cadeia de componentes executada em menos de um minuto. O harness integral
precisa provar todos os caminhos relevantes, janela, concorrência e retries.

Com baseline682, uma reservaV1 de3600 projeta4282, acima3900. Um modelo futuro
que tivesse comprovado um bound completo2816 projetaria3498, sem mudar o teto
nem gastar os2100de recovery. Essa diferença é quantização do contratoV1,
não evidência de VPS fisicamente lotado. A histerese precisa acompanhar o peso
exato também: não é válido usar a abertura de2700 para autorizar2816.

Comparação operacional recebida pelo coordenador em16/10/2026,19:10:40Z:

| Executor | Motores/slots | Residentes observadas | Média weight | CPU | RAM usada/limite MB | Reconciliação p95 ms |
| --- | --- | ---: | ---: | ---: | --- | ---: |
|01|7/175|62|2486,73|3,397%|171,30/961,48|21625|
|02|7/175|52|2437,00|3,520%|172,93/961,48|21816|
|03|2/50|12|682,00|1,067%|136,91/961,48|22008|

Todos estavam sem backlog/erro/retry, com15amostras e16motoresACTIVE;
Watchdog3HEALTHY. É um snapshot histórico, não autorização posterior. Não prova
quanto custaria um motor50 novo, nem a reserva futura de todas as posições.

### Readback oficial e arbitragem final V1 — 20:06:59Z

Consulta autenticada estritamente READ ONLY em16/10/2026, projeto OnPlay Platform
`otdfpmsegjxpqrzisfmi`, schema `coinops`:

- Executor03 HEALTHY; média sustentada771,25, atual730, pico774,16amostras;
  heartbeat/amostra20:06:42Z, runtime publicado `7f93dc8a687edb6b4bd509f3ccdf5aafa56f860a`.
- Preview oficial de4unidades: incremento3600 + baseline771,25 + reserva pendente0
  =4371,25, acima3900 por471,25. Resultado `CAPACITY_REQUIRED`, motivo
  `SUSTAINED_PROJECTION_ABOVE_ADMISSION_LIMIT`. Readiness estava true.
- Perfil exato50: `CAPACITY_UNKNOWN / SLOT_WORKLOAD_UNCERTIFIED`.
- Recovery2100 continua reservado uma única vez pelo teto3900. Não o subtrair
  novamente, emprestar de outro IP ou disponibilizá-lo a cada motor.

O trace2807 não cabe em3unidades2700; seu piso V1 já exige4unidades3600, que
não cabem nessa média atual. Isso não certifica que3600 seja um upper bound.
Um V2 hipotético com incremento2807 projetaria3578,25, mas seria incorreto
ativá-lo: o perfil completo e sua histerese por peso exato ainda não existem.

A prova offline posterior com **cadência natural de60s** observou fases
3134/3084/2404, janela rolling60s4933 e minuto alinhado4552 no agregado
conservador privado+público. Assim, nem um resultado por invocação nem o menor
trace2807 pode ser tratado como máximo por minuto. Per-host e detalhes dos
faults devem ser consultados na evidência integral do harness, não inferidos.

O caso com dois irmãos25 simultâneos observou8515 em20,5s (1442/3414/3659 por
motor), incluindo5707 no host privado. Isolamento financeiro passou, capacidade
não. Não somar novamente o baseline dos mesmos irmãos a esse trace. O agregado
não prova violação factual de quota Binance entre hosts distintos, mas refuta
uma certificação conservadora que exija preservar3900 de carga ordinária e2100
para recovery. Transporte simulado não ensaia o bloqueio real de quota.

Causas estruturais ainda relevantes: leituras por ordem e snapshots legados25,
além das coletas/janelas account-global que podem expirar entre leases. Os
boundaries preservam TP e idempotência, mas não constituem pacing certificado
por IP/minuto. Não alterar25, aumentar limites ou consumir recovery apenas para
emitir PASS. A decisão correta permanece não certificar/admitir50 por enquanto.

Evidência reproduzível: `coinops-fifty-fill-directed-tests-20261016.md`,
`coinops-fifty-control-flow-bound-20261016.md` e
`coinops-release-pre-migration-readonly-20261016.sql` em `docs/evidence/`.
O readback confirmou também corpos antigos iguais a main6ec2339, helpers novos
ausentes e migrations192533/193756 ainda não aplicadas. O histórico mais novo
era192312 de outro produto, preservado. Isso é pré-checagem, não aplicação.

## Proposta futura de peso exato — NÃO IMPLEMENTADA

Se o perfil medido e conservador continuar bloqueado apenas pela quantização,
considerar contratoV2 com `reserved_weight_per_minute` numérico explícito.
Preservar900como fallback legado25 e os limites3900/2100,3600,4500 e5400.
Não recalibrar o fallback com uma medição isolada. Não duplicar a fórmula.

Um único núcleo SQL de admissão receberia o peso solicitado. O wrapper legado
traduziria `N` em900×N; o wrapper de slots somaria os bounds exatos certificados.
A reserva serializada persistiria o mesmo peso usado no preview; replay excluiria
a própria reserva. Não usar `ceil(slot_count/25)` ou outra equivalência de motores.

### Histerese contínua, sem uma chave por combinação

As condições são monotônicas no peso adicional: se um peso é admissível,
qualquer peso menor também é. Portanto um único teto histerético `B` por
shard/ambiente pode representar a elegibilidade, sem criar linhas para pesos
arbitrários ou combinações de motores.

Somente uma **nova coleta** avançaria esse estado:

1. Erro de safety, gap>120s ou troca de contrato/política: `B=0`, reiniciar janela.
2. Encolher o teto anterior pela folga atual do limite normal e pelo guard90%.
3. Após uma janela íntegra de600s de amostras válidas, obter o menor headroom
   de reabertura60% dessa janela. Só essa folga sustentada permite expandirB.
4. O núcleo testa `reservas pendentes + peso novo <= B` e todos os guards atuais,
   incluindo atual>=4500 e projeção atual>=5400. Igualdade5400 continua negada.

As observações precisam conter a validade/safety e a versão usada na época;
ausência não é estado saudável. Limitar a janela em tempo/linhas pela coleta
existente; nenhuma coleta Binance, cron ou leitura por render nova. GET/reload
não escreve estado nem prolonga tempo. Não fabricar600s com timestamps antigos.

Antes de implementar, demonstrar equivalência com todos os buckets legados900×N
em traces de pressão, deadband, erros, replay, out-of-order e gaps; testar pesos
não múltiplos de900 e reservas concorrentes. A migration deve iniciar fechada,
aquecer com observações reais e afetar somente novas admissões, nunca pausar
motores existentes. Se a otimização segura permitir certificar o perfil atual
sem essa evolução, a migration de peso exato não é necessária para a ativação.

## Vínculo de código web — correção mínima local, aplicação remota pendente

O SQLV1 anterior compara runtime do executor, Node e política, mas não o código
web que executa Strategy Engine/reconciliação. O vínculo de `web_sha` somente no
registro não invalida um perfil após publicação financeira posterior. A correção
abaixo está implementada e testada localmente; isso não comprova aplicação remota.

Amarrar ao SHA inteiro também invalidaria um perfil por documentação sem impacto.
A correção usa `web_workload_sha256`, calculado deterministicamente sobre
o grafo server-side relevante para execução/onboarding/capacidade/budget, junto
ao lockfile das dependências executáveis. Incluir imports locais/aliases e imports
dinâmicos literais; dependência dinâmica não resolvida deve falhar no build, nunca
ser omitida silenciosamente. Documentos, screenshots, testes e UI não importada
por esse grafo não mudam o fingerprint. O SHA Git permanece como proveniência.
Opções de compilação/resolução do TypeScript são incluídas de modo canônico;
somente a lista `include` autogerada pelo Next não muda essa identidade.

O prebuild confere o módulo gerado server-only byte a byte com o grafo calculado;
sem chave, chamada remota ou nova infraestrutura. `--write` regenera o artefato
local e requer revisão. O helper oficial exige hash e prova de bytes em main,
além do fingerprint executor/política. O cliente service-role CoinOps injeta
`x-coinops-workload-sha256` em todas as chamadas. O núcleo SQL único lê esse
header de `request.headers` e exige igualdade com o perfil exato non25; não há
campo de autorização fornecido pelo navegador, mudança de assinatura dos RPCs
ou duplicação da fórmula de admissão. Ausência/JSON inválido/hash diferente
falham fechados. O caso25 retorna antes da leitura do header, sem mudança.

Migration local: `20261016192533_bind_slot_workload_web_fingerprint.sql`.
Ela altera somente o guard canônico usado por preview/append/reserva/ativação;
não modifica tabelas financeiras nem pausa motores ACTIVE. Perfis diferentes são
preservados pelo registro atômico, mas hash antigo não autoriza nova admissão.
O registro via CLI configura header transacional e exige readback do hash;
guard antigo sem esse contrato faz rollback. Nenhum perfil deve ser emitido
apenas por esta implementação: os sete cenários medidos continuam obrigatórios.

### Registro operacional — separado da ativação

`certify-slot-workload.mjs` não mede nem inventa os sete cenários. Exige artefato
revisado `SLOT_WORKLOAD_EVIDENCE_V1`, quantidade exata, limite superior conservador,
sete resultados PASS, digest íntegro, `web_sha` de main, `web_workload_sha256`,
runtime/Node/política corretos e resultados anexos. Não há artefato50 PASS emitido
por esta revisão; o contraexemplo anterior não é limite superior por minuto.

O modo padrão/`--verify` verifica projeto oficial pela CLI autenticada já
instalada, bytes Git/main e grafo, registry completo duas vezes, amostras frescas,
fleet por leitura SSH do kernel existente e merge que preserva outros perfis.
Não lê `.env`, credenciais Binance/vault, tokens nem chaves em texto e não grava.

Somente `--record` explícito tenta uma transação: advisory fence oficial, locks
do controle, CAS de registry/release/attestações, header de workload local à
transação, uma chamada do RPC oficial `certify_executor_admission` e readback
integral dos perfis/digest/hash. Resposta incerta exige leitura, nunca retry cego.
Não cria/ativa motor, não reserva capital e não modifica ordens. Depois do registro,
os gates financeiros/Admission/whitelist/ownership continuam independentes.

O grafo inclui execução/onboarding/capacidade/Watchdog e opções canônicas
do compilador. A contagem e o hash finais, aplicação da migration, perfil, main, runtime e deploy
permanecem pendentes até a publicação coordenada; mudanças financeiras em andamento
exigem regenerar o manifesto antes do único build/publicação final. Quantidade de
arquivos ou um fingerprint PASS não provam capacidade50/100.

## Evidência e fechamento

- Teste de projeçãoV1: `tools/operations/certify-slot-workload-model.test.mjs`,
  funções SQL canônicas em PostgreSQL/WASM descartável. Readiness/safety globais
  são fronteiras explícitas de fixture; não se trata de nova certificação.
- Teste N+1: `apps/web/lib/execution/account-order-budget.test.ts`.
- Helper de registro: `tools/operations/certify-slot-workload.mjs`, VERIFY padrão,
  artefato íntegro com sete cenários obrigatórios, fleet, preservação e CAS.
- Fingerprint/CLI/SQL: 12 testes locais PASS, incluindo header ausente/diferente/
  malformado, legado25, merge, CAS, rollback e ambiguidade de imports; cliente
  service-role: 2 testes PASS (header do servidor e abort/timeout preservados).
- Harness integral e medições posteriores devem ser avaliados separadamente;
  dados deste snapshot/trace não antecipam o resultado após otimizações.

**Nenhuma migration remota, certificação ou operação LIVE foi realizada por esta revisão.**
