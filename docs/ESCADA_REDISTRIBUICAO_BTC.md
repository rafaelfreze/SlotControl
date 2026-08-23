# Escada de Redistribuição BTC e SOL

## 1. Autoridade e escopo

Este documento é a fonte oficial da gestão mensal dos slots BTC e SOL no CoinOps real. Os dois ativos seguem o mesmo fluxo seguro; somente a meta configurada, a taxa da estratégia e a composição financeira de cada slot são diferentes.

Entrada e saída de operações, ATH, autenticação e módulos não relacionados permanecem fora do escopo desta regra.

No ambiente integrado, tabelas, funções e ledgers deste domínio permanecem isolados no schema `coinops` e continuam vinculados ao produto, tenant e usuário autenticado.

Backtests e simuladores locais não definem esta regra. Eles podem validar hipóteses, mas não podem alterar o comportamento financeiro descrito aqui.

## 2. Objetivo da meta mensal

As metas mensais começam em **7 gains para BTC** e **1 gain para SOL** e podem ser editadas. Toda alteração é persistida e auditada.

A meta representa a velocidade desejada de evolução da escada. Ela não cria uma dívida de `7 × meses` para cada slot e não obriga os 25 slots a atingirem o mesmo acumulado.

A tela Plano mostra o ciclo atual de 30 dias, os gains reais obtidos no período e a escada atual. O `month_reference` é resolvido no backend a partir da data inicial operacional; o frontend não escolhe livremente a competência financeira.

Para facilitar o acerto após informar uma data antiga, o Plano também mostra uma **meta orientativa do líder**:

```text
meta do líder = meta mensal × número do ciclo atual
```

Exemplo: início em 01/04, quinto ciclo e meta mensal 7 resultam em 35 gains operacionais para o líder. Essa conta orienta somente o slot líder e o ajuste manual; ela não cria dívida de 35 gains para cada um dos 25 slots.

### Data inicial operacional

`growth_plan_settings.started_at` é a única fonte de verdade para o tempo em operação e para os ciclos BTC e SOL. Ela é independente de `auth.users.created_at`, pois uma consolidação ou migração de Auth pode recriar o usuário sem reiniciar a operação financeira.

A data pode ser editada na tela Plano por uma RPC autenticada e auditada. A alteração:

- recalcula dias operados, ciclo atual e competência dos próximos cálculos;
- atualiza o mesmo tempo exibido no Resumo;
- não altera slots, `real_gains`, `operational_gains`, valores, posições ou histórico financeiro já existente;
- marca qualquer prévia BTC ou SOL ainda `PREPARED` como `STALE`, exigindo uma nova prévia na nova competência;
- registra antes/depois em `coinops.growth_plan_start_audit`.

Os ciclos são contínuos em blocos de 30 dias a partir dessa data: dias 1–30 formam o primeiro ciclo, 31–60 o segundo, 61–90 o terceiro e assim por diante.

## 3. Contadores e fontes de capital

Os conceitos são permanentemente separados:

- `real_gains`: operações realmente concluídas. É cumulativo e imutável; pode apenas aumentar em uma transição válida de slot aberto para gain.
- `operational_gains`: posição atual do slot na escada. Pode subir com gain real, gain manual ou redistribuição recebida, e cair com redistribuição enviada. Um aporte informado diretamente em USDT altera o saldo, não esse contador.
- `added_gains`: classificação legada dos gains adicionados antes desta escada. Os valores existentes são preservados e registrados no saldo de abertura, sem reclassificação automática.
- `gains`: campo histórico de compatibilidade com a decomposição anterior. Não é a fonte do ranking da nova escada.
- `growth_contribution`: aportes externos em USDT.
- `redistribution_received_usdt` e `redistribution_sent_usdt`: movimentações internas acumuladas, mantidas separadas dos aportes e dos lucros reais.

É válido um slot possuir `real_gains = 20` e `operational_gains = 14`.

O saldo operacional considera capital-base, gains compostos realizados, aporte externo e o saldo líquido de redistribuição. Redistribuição não é lucro e não é aporte externo.

Dois slots com quantidades operacionais próximas podem ter saldos diferentes porque cada saldo consolida sua própria trajetória de gains, aportes e redistribuições. A linha principal de Slots mostra somente o saldo operacional total, já com todos esses movimentos somados ou subtraídos. O detalhe mantém separados gains reais, gains aportados, aporte externo bruto, redistribuição líquida e capital adicional líquido, permitindo reconstruir a composição sem confundir aporte com lucro.

Cada gain real ou manual é aplicado uma vez sobre o saldo imediatamente anterior. Para `N` gains inteiros:

```text
saldo_depois = round(saldo_antes × (1 + taxa)^N, 8)
aporte_dos_gains = saldo_depois - saldo_antes
```

Assim, dez gains de 1% não são uma parcela linear de 10% sobre a base antiga: são dez multiplicações sucessivas por `1,01`. Um gain posterior sempre parte do saldo produzido pelo gain anterior.

Um aporte informado diretamente em USDT é diferente: o valor entra integralmente no saldo, sem criar gain operacional nem gain real. Na próxima operação, os gains passam a incidir sobre esse novo saldo completo.

Ao abrir uma nova operação BTC ou SOL, o CoinOps congela o saldo operacional total daquele instante como valor da posição. O próximo gain real é calculado sobre esse snapshot completo (`saldo congelado × taxa do gain`). Assim, aportes e redistribuições já incorporados participam dos gains futuros. Uma posição que já estava OPEN preserva seu notional, preço, alvo e data originais e nunca é reescrita no meio da execução.

## 4. Referência assistida

A referência operacional da redistribuição é explícita e editável. O sistema não inventa uma referência rígida a partir da meta mensal.

Ao preparar um batch, o usuário informa o nível de referência `L`. Uma referência anterior pode ser apresentada como conveniência, mas continua editável e só produz efeitos depois da confirmação da nova prévia.

Sem referência válida não existe redistribuição automática nem movimentação financeira.

## 5. Ranking e algoritmo determinístico

O ranking de cada ativo usa `operational_gains DESC`, com desempate por:

1. `slot_number ASC`;
2. `sort_order ASC`;
3. `id ASC`.

Doadores são slots acima de `L`, na ordem do ranking. Recebedores são slots abaixo de `L`, também em ordem decrescente de `operational_gains`. Assim, o recebedor mais próximo da referência é completado primeiro.

Status não bloqueia participação. Slots `OPEN`, em espera ou livres podem doar e receber.

Tanto a referência quanto `operational_gains` são níveis inteiros. A escada
nunca cria `14,66`, `3,25` ou qualquer outro gain operacional fracionado.

Para cada par elegível:

```text
excedente do doador = operational_gains do doador - L
defasagem do recebedor = L - operational_gains do recebedor

capacidade do doador em USDT = excedente × unidade do gain do doador
necessidade do recebedor em USDT = defasagem × unidade do gain do recebedor

valor candidato = gains inteiros do doador × unidade do gain do doador

o candidato só é elegível quando:
- retira uma quantidade inteira de gains do doador;
- acrescenta somente a quantidade inteira de gains que o valor comporta no recebedor;
- cabe no excedente operacional e financeiro do doador;
- cabe na defasagem do recebedor.
```

A busca começa pelo maior excedente inteiro do doador que o recebedor atual
consegue absorver sem ultrapassar a referência. Todos os doadores acima de `L`
são percorridos; a sobra de cada um continua descendo pela lista de recebedores.
Se as unidades financeiras forem diferentes, os centavos que não completam um
gain permanecem no saldo operacional do recebedor. Eles não viram gain
fracionado e não são perdidos. Quando nenhum recebedor consegue formar ao menos
um gain inteiro, o excedente restante permanece no doador.

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

Se as unidades forem diferentes, o mesmo USDT pode representar quantidades
inteiras diferentes no doador e no recebedor. Por isso o ledger guarda
`donor_gain_equivalent` e `receiver_gain_equivalent` separadamente. O saldo
financeiro recebe o valor exato; somente gains completos entram no contador
operacional. O valor em USDT debitado e creditado continua idêntico.

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

1. carregar a escada do ativo escolhido;
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

- `coinops.btc_redistribution_batches`: competência, ativo, referência, algoritmo, snapshot, rankings, totais, conservação, idempotência e status; o nome físico legado foi preservado por compatibilidade;
- `coinops.btc_redistribution_transfers`: uma linha imutável por transferência BTC ou SOL, com doador, recebedor, statuses e valores antes/depois;
- `coinops.slot_capital_ledger`: partidas de abertura, gain real, débito, crédito e aporte externo;
- `coinops.btc_external_contributions`: aportes externos manuais BTC ou SOL, com nome físico legado preservado;
- `coinops.slot_compounding_adjustments`: auditoria imutável do antes/depois da conversão única para saldo composto sequencial;
- `coinops.growth_plan_goal_audit`: alterações das metas mensais BTC e SOL;
- `coinops.growth_plan_start_audit`: alterações da data inicial operacional e quantidade de prévias invalidadas.

A confirmação usa lock transacional e bloqueio das linhas dos slots. A mesma chave de confirmação não cria um segundo efeito. Duas abas não podem aplicar o mesmo patrimônio duas vezes: o primeiro request que confirma um batch conclui; qualquer repetição desse mesmo batch retorna o resultado já persistido sem movimentar capital novamente.

BTC e SOL podem concluir quantas redistribuições forem necessárias dentro do mesmo ciclo de 30 dias. Cada nova redistribuição exige uma nova prévia server-side e uma nova intenção idempotente. Ao preparar outra prévia do mesmo ativo e ciclo, apenas uma prévia anterior ainda pendente fica obsoleta; batches já concluídos permanecem imutáveis no histórico. O ativo continua isolado, portanto uma nova redistribuição BTC não invalida nem altera uma redistribuição SOL, e vice-versa.

O ledger deve permitir reconstruir cada transferência sem consultar estado futuro dos slots.

## 10. Gains operacionais manuais

O Plano permite escolher um slot e informar diretamente quantos gains operacionais inteiros devem ser adicionados. O servidor aplica cada gain sequencialmente sobre o saldo vigente, calcula como aporte exatamente a diferença entre o saldo composto final e o saldo inicial, registra valor, slot, data, motivo e usuário, e mantém a mesma trilha financeira de aportes externos.

O formulário sugere automaticamente a diferença entre a meta orientativa do líder e seu nível atual. O usuário pode alterar tanto o slot quanto a quantidade antes de confirmar. Nenhum ajuste é automático.

O ajuste por gains:

- aumenta `growth_contribution` e `operational_gains` conforme a conversão de domínio;
- não aumenta `real_gains`;
- não altera os gains adicionados legados;
- não movimenta patrimônio de outro slot;
- possui chave idempotente própria e lançamento `EXTERNAL_CONTRIBUTION` no ledger.

O cálculo é composto e determinístico:

```text
saldo_composto = round(saldo_atual × (1 + gain_rate)^gains_informados, 8)
amount_usdt = saldo_composto - saldo_atual
operational_gains_after = operational_gains_before + gains_informados
```

Exemplo: com saldo de 10 USDT e taxa de 1%, dez gains manuais produzem `10 × 1,01^10 = 11,04622125 USDT`. O aporte auditado é a diferença de `1,04622125 USDT`, não uma soma linear de `1,00 USDT`.

Também existe a opção separada **Adicionar saldo em USDT**. Nesse modo, 5 USDT somados a um saldo de 10 resultam exatamente em 15 USDT, sem alterar `real_gains` ou `operational_gains`; os gains da próxima posição passam a ser calculados sobre 15 USDT.

Uma prévia de redistribuição ainda `PREPARED` é marcada como `STALE` após qualquer ajuste de capital ou gains, pois o ranking e os saldos mudaram.

Não existe aporte automático nem obrigação de completar todos os slots. Os gains manuais aparecem no histórico como ajuste/aporte e nunca são classificados como gains reais.

## 11. Backfill e preservação

A migration inicial deve ser aditiva e preservar integralmente o estado anterior:

- `operational_gains` recebe o valor corrente de `gains`;
- saldos enviados e recebidos começam em zero;
- cada slot BTC e SOL recebe um `OPENING_BALANCE` append-only na entrada de sua escada;
- `real_gains`, `added_gains`, `gains`, valores, status, preços e históricos existentes não são zerados nem reclassificados;
- posições BTC e SOL abertas recebem snapshots sem alterar os campos já executados.

A conversão da contabilidade linear antiga para a composição sequencial reproduz o ledger imutável na ordem dos eventos. Ela corrige somente `realized_profit`, o valor efetivo dos aportes manuais antigos e a unidade contábil de gain de posições abertas. `real_gains`, `operational_gains`, status, notional, quantidade, entrada, alvo, datas e histórico permanecem intactos. Cada antes/depois é registrado em `coinops.slot_compounding_adjustments`.

No corte para a escada inteira, níveis operacionais fracionados que já tenham
sido produzidos pela regra anterior são truncados apenas no contador da
escada. O valor financeiro não é reduzido nem movido: a fração permanece no
mesmo slot. Cada correção é registrada em
`coinops.operational_gain_normalization_audit`, com nível anterior, nível
inteiro posterior, fração e USDT retidos. Gains reais, gains legados, posições
e histórico financeiro permanecem intactos.

Gains adicionados anteriores são registrados como legado de origem não verificada. Eles não são transformados automaticamente em gain real nem em novo aporte externo.

## 12. Segurança

As tabelas financeiras têm RLS forçada e leitura limitada ao escopo autenticado do CoinOps. Usuários autenticados não recebem permissão de escrita direta nessas tabelas.

As mutações são server-side, validam produto, tenant, usuário, ativo BTC/SOL, vínculo, ownership dos slots, snapshot e chave idempotente. `service_role` nunca é exposta no frontend.

## 13. Igualdade funcional BTC/SOL

No menu Slots, gains reais e gains adicionados legados são somente leitura para os dois ativos. Adições manuais acontecem exclusivamente no Plano e entram como capital externo auditado, nunca como gain real.

No menu Plano, BTC e SOL possuem exatamente o mesmo conjunto de ações:

- editar a meta mensal do próprio ativo;
- consultar gains reais do ciclo e o ranking operacional;
- adicionar gains operacionais manualmente em qualquer slot;
- escolher uma referência e preparar a redistribuição;
- revisar conservação, doadores e recebedores;
- cancelar ou confirmar;
- consultar histórico detalhado.

O fechamento do ciclo não movimenta capital automaticamente. A redistribuição somente acontece quando o usuário prepara e confirma a prévia do ativo. Slots OPEN continuam elegíveis e a sobra do líder segue para os próximos slots pela mesma regra determinística.

## 14. Critérios de validação

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
- migrations `20260809033335_add_btc_ladder_redistribution.sql`, `20260809033608_index_btc_ladder_product_foreign_keys.sql`, `20260809165604_allow_edit_growth_plan_start_date.sql`, `20260810125830_add_btc_manual_operational_gains.sql`, `20260810134300_generalize_growth_ladder_btc_sol.sql` e `20260811021309_enforce_integer_ladder_gains.sql` já aplicadas nessa base local;
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
