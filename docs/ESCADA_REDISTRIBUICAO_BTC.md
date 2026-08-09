# Escada de Redistribuição BTC

## 1. Autoridade e escopo

Este documento é a fonte oficial da gestão mensal dos slots BTC no CoinOps real.

A implementação inicial cobre somente BTC. SOL, entrada e saída de operações, ATH, autenticação e módulos não relacionados permanecem fora do escopo.

No ambiente integrado, tabelas, funções e ledgers deste domínio permanecem isolados no schema `coinops` e continuam vinculados ao produto, tenant e usuário autenticado.

Backtests e simuladores locais não definem esta regra. Eles podem validar hipóteses, mas não podem alterar o comportamento financeiro descrito aqui.

## 2. Objetivo da meta mensal

A meta mensal BTC começa em **7 gains** e pode ser editada. Sua alteração deve ser persistida e auditada.

A meta representa a velocidade desejada de evolução da escada. Ela não cria uma dívida de `7 × meses` para cada slot e não obriga os 25 slots a atingirem o mesmo acumulado.

A tela Plano mostra o ciclo atual de 30 dias, os gains reais obtidos no período e a escada atual. O `month_reference` é resolvido no backend a partir da data inicial operacional; o frontend não escolhe livremente a competência financeira.

### Data inicial operacional

`growth_plan_settings.started_at` é a única fonte de verdade para o tempo em operação e para os ciclos BTC e SOL. Ela é independente de `auth.users.created_at`, pois uma consolidação ou migração de Auth pode recriar o usuário sem reiniciar a operação financeira.

A data pode ser editada na tela Plano por uma RPC autenticada e auditada. A alteração:

- recalcula dias operados, ciclo atual e competência dos próximos cálculos;
- atualiza o mesmo tempo exibido no Resumo;
- não altera slots, `real_gains`, `operational_gains`, valores, posições ou histórico financeiro já existente;
- marca qualquer prévia BTC ainda `PREPARED` como `STALE`, exigindo uma nova prévia na nova competência;
- registra antes/depois em `coinops.growth_plan_start_audit`.

Os ciclos são contínuos em blocos de 30 dias a partir dessa data: dias 1–30 formam o primeiro ciclo, 31–60 o segundo, 61–90 o terceiro e assim por diante.

## 3. Contadores e fontes de capital

Os conceitos são permanentemente separados:

- `real_gains`: operações realmente concluídas. É cumulativo e imutável; pode apenas aumentar em uma transição válida de slot aberto para gain.
- `operational_gains`: posição atual do slot na escada. Pode subir com gain real, redistribuição recebida ou aporte externo, e cair com redistribuição enviada.
- `added_gains`: classificação legada dos gains adicionados antes desta escada. Os valores existentes são preservados e registrados no saldo de abertura, sem reclassificação automática.
- `gains`: campo histórico de compatibilidade com a decomposição anterior. Não é a fonte do ranking da nova escada.
- `growth_contribution`: aportes externos em USDT.
- `redistribution_received_usdt` e `redistribution_sent_usdt`: movimentações internas acumuladas, mantidas separadas dos aportes e dos lucros reais.

É válido um slot possuir `real_gains = 20` e `operational_gains = 14`.

O valor operacional considera capital-base, lucro realizado, aporte externo e o saldo líquido de redistribuição. Redistribuição não é lucro e não é aporte externo.

## 4. Referência assistida

A referência operacional da redistribuição é explícita e editável. O sistema não inventa uma referência rígida a partir da meta mensal.

Ao preparar um batch, o usuário informa o nível de referência `L`. Uma referência anterior pode ser apresentada como conveniência, mas continua editável e só produz efeitos depois da confirmação da nova prévia.

Sem referência válida não existe redistribuição automática nem movimentação financeira.

## 5. Ranking e algoritmo determinístico

O ranking BTC usa `operational_gains DESC`, com desempate por:

1. `slot_number ASC`;
2. `sort_order ASC`;
3. `id ASC`.

Doadores são slots acima de `L`, na ordem do ranking. Recebedores são slots abaixo de `L`, também em ordem decrescente de `operational_gains`. Assim, o recebedor mais próximo da referência é completado primeiro.

Status não bloqueia participação. Slots `OPEN`, em espera ou livres podem doar e receber.

Para cada par elegível:

```text
excedente do doador = operational_gains do doador - L
defasagem do recebedor = L - operational_gains do recebedor

capacidade do doador em USDT = excedente × unidade do gain do doador
necessidade do recebedor em USDT = defasagem × unidade do gain do recebedor

valor transferido = menor(capacidade, necessidade)

equivalente debitado = valor transferido / unidade do gain do doador
equivalente creditado = valor transferido / unidade do gain do recebedor
```

A sobra continua para o próximo recebedor. Quando não há recebedor elegível, o excedente permanece no doador.

Exemplo com unidade financeira igual nos slots:

```text
Referência: 14
A = 20
B = 10

A -> B: 4 gains equivalentes
Resultado: A = 16, B = 14
```

```text
Referência: 14
A = 20
B = 10
C = 12

A -> C: 2 gains equivalentes
A -> B: 4 gains equivalentes
Resultado: A = 14, B = 14, C = 14
```

A ordem `C` antes de `B` decorre da prioridade oficial de completar primeiro quem está mais próximo da referência.

## 6. Conversão gains ↔ USDT

A conversão é centralizada e usa a composição financeira vigente do slot:

```text
gain_unit_usdt = round((base_value + growth_contribution) × gain_rate, 8)
```

O cálculo de prévia e o cálculo de confirmação devem usar a mesma função de domínio.

Se as unidades forem diferentes, o mesmo USDT pode representar equivalentes diferentes no doador e no recebedor. Por isso o ledger guarda `donor_gain_equivalent` e `receiver_gain_equivalent` separadamente. O valor em USDT debitado e creditado continua idêntico.

Todos os valores persistidos usam `numeric` com oito casas. Para cada transferência:

```text
debited_usdt = credited_usdt = amount_usdt
```

Para o batch:

```text
equity_before = equity_after
equity_difference = 0
```

Se a conservação falhar, a confirmação inteira deve ser revertida.

## 7. Slots abertos e posição executada

Um slot aberto pode ser doador. O débito operacional e contábil acontece no momento da confirmação, sem esperar o fechamento da posição.

Redistribuição nunca modifica:

- quantidade executada da posição, quando existir;
- preço de entrada;
- preço-alvo;
- timestamps da posição;
- histórico da abertura.

O CoinOps guarda snapshots contábeis da posição aberta, incluindo o notional e a unidade de gain da abertura. Uma redistribuição posterior altera o saldo operacional, mas não reescreve o negócio já executado.

Quando a posição fecha, somente o gain real é acrescentado. O total enviado anteriormente permanece em `redistribution_sent_usdt`; portanto, o capital transferido não reaparece no doador.

## 8. Preparação, edição e confirmação

Redistribuição nunca é executada silenciosamente.

O fluxo oficial é:

1. carregar a escada BTC;
2. informar ou ajustar a referência assistida;
3. solicitar uma prévia server-side;
4. revisar ranking anterior, doadores, recebedores, equivalentes, USDT, ranking posterior e conservação;
5. cancelar ou confirmar;
6. recarregar os saldos e o histórico persistido.

O frontend envia intenção, IDs e chave idempotente. O servidor recarrega os slots, recalcula unidades, montantes e conservação. Valores calculados no navegador não são confiáveis para mutação financeira.

A prévia possui snapshot/hash. Se qualquer slot relevante mudar antes da confirmação, o batch fica obsoleto e uma nova prévia é obrigatória.

## 9. Ledger, transação e idempotência

O fechamento mensal é um batch transacional: tudo aplica ou nada aplica.

As estruturas oficiais são:

- `coinops.btc_redistribution_batches`: competência, referência, algoritmo, snapshot, rankings, totais, conservação, idempotência e status;
- `coinops.btc_redistribution_transfers`: uma linha imutável por transferência, com doador, recebedor, statuses e valores antes/depois;
- `coinops.slot_capital_ledger`: partidas de abertura, gain real, débito, crédito e aporte externo;
- `coinops.btc_external_contributions`: aportes externos manuais;
- `coinops.growth_plan_goal_audit`: alterações da meta mensal BTC.
- `coinops.growth_plan_start_audit`: alterações da data inicial operacional e quantidade de prévias invalidadas.

A confirmação usa lock transacional e bloqueio das linhas dos slots. A mesma chave de confirmação não cria um segundo efeito. Duas abas não podem aplicar o mesmo patrimônio duas vezes: o primeiro batch válido conclui; o seguinte precisa falhar como conflito ou snapshot obsoleto.

O ledger deve permitir reconstruir cada transferência sem consultar estado futuro dos slots.

## 10. Aporte externo manual

Após a redistribuição, o usuário pode aportar USDT em um slot escolhido. O aporte registra valor, slot, data, motivo e usuário.

O aporte:

- aumenta `growth_contribution` e `operational_gains` conforme a conversão de domínio;
- não aumenta `real_gains`;
- não altera os gains adicionados legados;
- não movimenta patrimônio de outro slot;
- possui chave idempotente própria e lançamento `EXTERNAL_CONTRIBUTION` no ledger.

Como o próprio aporte aumenta `growth_contribution`, ele também aumenta a unidade financeira dos gains futuros. Para não inflar o poder financeiro do aporte, seu novo equivalente operacional é calculado com a unidade **pós-aporte**:

```text
growth_after = growth_before + amount_usdt
gain_unit_after = round((base_value + growth_after) × gain_rate, 8)
gain_equivalent = amount_usdt / gain_unit_after
operational_gains_after = operational_gains_before + gain_equivalent
```

É incorreto dividir o aporte pela unidade anterior, pois uma unidade menor produziria mais gains equivalentes do que o capital novo realmente suporta depois de incorporado ao slot.

Não existe aporte automático nem obrigação de completar todos os slots.

## 11. Backfill e preservação

A migration inicial deve ser aditiva e preservar integralmente o estado anterior:

- `operational_gains` recebe o valor corrente de `gains`;
- saldos enviados e recebidos começam em zero;
- cada slot BTC recebe um `OPENING_BALANCE` append-only;
- `real_gains`, `added_gains`, `gains`, valores, status, preços e históricos existentes não são zerados nem reclassificados;
- posições BTC abertas recebem snapshots sem alterar os campos já executados;
- SOL não sofre mudança de regra.

Gains adicionados anteriores são registrados como legado de origem não verificada. Eles não são transformados automaticamente em gain real nem em novo aporte externo.

## 12. Segurança

As tabelas financeiras têm RLS forçada e leitura limitada ao escopo autenticado do CoinOps. Usuários autenticados não recebem permissão de escrita direta nessas tabelas.

As mutações são server-side, validam produto, tenant, usuário, ativo BTC, vínculo, ownership dos slots, snapshot e chave idempotente. `service_role` nunca é exposta no frontend.

## 13. Critérios de validação

| # | Critério | Camada mínima |
|---|---|---|
| 1 | A20/B10, referência 14 → A16/B14 | domínio puro |
| 2 | A20/B10/C12 → A14/B14/C14 | domínio puro |
| 3 | o mesmo resultado com A aberto | domínio puro + integração |
| 4 | `real_gains` de A permanece 20 | domínio puro + banco |
| 5 | posição aberta não é reescrita | domínio puro + banco |
| 6 | débito não reaparece no fechamento | banco/transação |
| 7 | conservação financeira | domínio puro + banco |
| 8 | batch idempotente | banco/RPC |
| 9 | dupla confirmação não duplica | concorrência/RPC |
| 10 | aporte não incrementa `real_gains` | banco/RPC |
| 11 | dados existentes são preservados | migration/backfill |
| 12 | RLS e autorização isolam o proprietário | banco/RLS |

O teste puro não substitui os testes transacionais, de concorrência e RLS. A publicação financeira exige as duas camadas.

## 14. Teste SQL transacional local

O teste permanente de banco está em `supabase/tests/btc_ladder_redistribution.sql`. Ele cria proprietários, estratégias e slots exclusivos de fixture, executa as RPCs com contexto `authenticated`, valida ledger/RLS e termina sempre com `ROLLBACK`.

Pré-requisitos:

- PostgreSQL/Supabase **local** com o scaffold compartilhado do CoinOps;
- migrations `20260809033335_add_btc_ladder_redistribution.sql`, `20260809033608_index_btc_ladder_product_foreign_keys.sql` e `20260809165604_allow_edit_growth_plan_start_date.sql` já aplicadas nessa base local;
- `psql` disponível;
- URL apontando explicitamente para a base local, nunca para o projeto vinculado/remoto.

Execução em PowerShell:

```powershell
$env:COINOPS_LOCAL_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:55432/coinops_ladder_test'
psql $env:COINOPS_LOCAL_DATABASE_URL `
  --set=coinops_fixture_mode=local-only `
  --set=ON_ERROR_STOP=1 `
  --file=supabase/tests/btc_ladder_redistribution.sql
```

O script recusa execução sem `coinops_fixture_mode=local-only`. Essa chave é uma trava contra disparo acidental, não uma autorização para usar banco remoto. O comando oficial deve sempre usar uma URL local explícita e não usa `supabase db push`, projeto vinculado nem dados reais.

O resultado esperado termina com:

```text
btc_ladder_redistribution.sql: all local transactional assertions passed
ROLLBACK
```
