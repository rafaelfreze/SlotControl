# Marco do capital operacional

## Regra aprovada

O proprietário autorizou incorporar os aportes e gains adicionados anteriores ao
marco inicial operacional. Os contadores de **aportes** e **gains adicionados**
reiniciam na ativação, não à meia-noite nem na data original da estratégia.

Isso não é uma venda nem um gain realizado: `real_gains`, `realized_profit`,
`operational_gains`, `growth_contribution`, `base_value`, saldo operacional e
posições abertas permanecem exatamente iguais. A origem dos valores continua
auditável. O marco também não reinicia o monitoramento oficial, seus ciclos,
metas, pools ou relatórios.

## Persistência e leitura

- `coinops.capital_accounting_openings`: um marco imutável por produto/tenant/usuário,
  com horário efetivo, motivo, chave idempotente, hash SHA-256, snapshots completos
  dos slots/aportes e hashes de histórico/ledger.
- A incorporação usa os **IDs presentes no snapshot**, não uma comparação de datas.
  Um aporte novo com data antiga continua sendo um lançamento novo.
- `coinops.slot_initial_capital`: recibo imutável do principal inicial de cada slot
  criado após o marco. O trigger apenas registra o valor, sem somá-lo novamente ao
  saldo. Atualizar o slot depois não reescreve seu principal histórico.
- `coinops.capital_reporting_entries`: view `security_invoker`, respeitando RLS
  e o resolvedor de escopo existente. Une aportes originais e recibos de novos
  slots. Os contadores excluem `incorporated_in_opening`; o histórico mantém tudo.
- O loader web pagina a view para evitar totais truncados pelo limite da API.
  O plano não mistura esses dados com a lista legada de contribuições do RPC.

As tabelas de auditoria são somente leitura para os papéis da aplicação. Somente
o trigger privilegiado registra novos recibos; os clientes não podem gravá-los
diretamente. Não há botão ou RPC público para reiniciar o marco repetidamente.

## Ativação controlada

Migration: `20260921120400_add_operational_capital_opening.sql`.
Alvo oficial: projeto `otdfpmsegjxpqrzisfmi`, schema `coinops`.

1. Confirmar ambiente, usuário e vínculo CoinOps ativo por leitura.
2. Aplicar a migration revisada e testada em PostgreSQL efêmero local.
3. Publicar o código e confirmar a implantação pelo fluxo Git oficial.
4. Obter o snapshot por `private.coinops_capital_opening_snapshot` e revisar
   quantidade de slots, patrimônio, ganhos realizados, posições e aportes.
5. Chamar `private.coinops_activate_capital_opening` com escopo confirmado,
   hash esperado, chave idempotente e motivo aprovado. Esta função é administrativa,
   `SECURITY INVOKER`, sem EXECUTE para anon/authenticated/service_role.
6. A função serializa brevemente as tabelas CoinOps afetadas, recusa snapshot
   desatualizado e verifica a igualdade financeira antes/depois. O lock expira
   em cinco segundos; não há tentativa parcial ou reset de dados.
7. Verificar o registro persistido, hash, totais atuais zero, histórico preservado
   e telas autenticadas em leitura. Nunca gerar aporte/gain/slot de teste remoto.

Uma resposta incerta exige consultar o marco pela chave antes de qualquer nova
tentativa. A mesma chave/hash/motivo retorna a ativação existente; uma segunda
ativação diferente é rejeitada.

A ativação e a captura de novos slots exigem transações `READ COMMITTED`, como
no runtime atual. `REPEATABLE READ` e `SERIALIZABLE` são recusados nesse fluxo
para impedir que um snapshot antigo atravesse o corte sem registrar o principal.

## Reversão e limitações

A migration é aditiva e compatível com o app anterior. Um rollback de código não
altera saldos nem apaga auditoria, mas a UI antiga volta a exibir contadores
históricos: não representa uma reversão contábil. Não apagar o marco nem os
recibos para desfazer a classificação; uma eventual correção exige nova decisão
explícita e migration auditada.

As fixtures SQL isoladas verificam o contrato desta migration, não substituem
o bootstrap completo da plataforma (que não está versionado neste repositório).
O teste reproduzível fica em `supabase/tests/operational_capital_opening.sql`:
exige cluster novo em loopback, database `coinops_opening_test`, modo explícito
`local-only` e faz rollback. Nunca executar contra o projeto Supabase vinculado.
