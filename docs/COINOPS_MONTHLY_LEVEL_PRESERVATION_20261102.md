# Virada mensal sem reancoragem de preços — 02/11/2026

CoinOps, REAL, Supabase `otdfpmsegjxpqrzisfmi`, schema `coinops`.
Correção prospectiva autorizada após auditoria, preservando as estratégias.

## Causa e alcance

`applyAthTransition` tratava mudança de mês como transição de ATH e chamava
`planAthLadder` com o ticker atual. OPEN/TP e reentradas locais ficavam congelados,
mas níveis GRID livres eram recriados. Na Thyely/SOLUSDT, a reentrada 92,99 foi
preservada enquanto o novo anchor 95,65 gerou GRID 92,78, separados por 0,226%,
embora a geometria individual estivesse correta para spacing de 3%.
Os TPs 98,11/97,89 estavam NEW; não eram duas vendas executadas ou duplicadas.

## Correção

Sem mudança real de regime/chave ATH, a virada mensal usa `PRESERVE_LEVELS` na
mesma função canônica: atualiza elegibilidade, rank e grupos, preservando todos
os preços, referências, proveniências GRID/REENTRY, capital, gain, spacing e meta.
Slots com meta individual voltam a ser elegíveis no mês-calendário local;
a exceção N/N metas completas continua funcionando sem zerar o ledger.
PRIMARY permanece até 15 elegíveis, demais RESERVE, conforme a regra vigente.

Não cancela BUY na etapa mensal. `armNextEntry` continua como única autoridade
para permutar o pool comprovado e, quando necessário, reconciliar uma BUY
residente via ONLY_NEW, zero fill, lease e CAS. Fill concorrente vence;
partial/OPEN não recebem outra entrada. As recuperações MARKET explicitamente
autorizadas continuam intactas. Um mês novo não implica compras em lote.

Ranks são metadados sob a lease; o watermark mensal só avança após concluir
essas gravações. Crash anterior repete somente os metadados. O checkpoint
`config_snapshot.monthly_priority_rollover` registra período anterior/atual,
`reanchored=false`, preservação dos níveis e contagens. A emissão normal usa
`MONTHLY_PRIORITY_REFRESHED`. O relatório v32 já exporta snapshot e detalhes
genéricos dos eventos; adiciona a descrição da correção no dataset de regras,
sem alterar formato nem reinterpretar snapshots históricos.

Transição ATH real, atualização explícita de spacing e reset integral continuam
usando a geometria canônica existente. Watermark ainda não inicializado conserva
o caminho de inicialização. Sem migration, alteração de credencial ou cron.

## Limites importantes

Não reprecificar retroativamente posições, TPs ou BUY existentes. Não impor um
espaçamento global entre todos os TPs ou reentradas de ciclos/anchors diferentes:
isso seria outra regra econômica. A correção elimina a criação de um anchor
adicional causada apenas pelo calendário; preços próximos já existentes ou
decorrentes das reentradas autorizadas podem permanecer.

## Verificação

- Fixture canônica reproduz Thyely 92,99/92,78 e confirma preservação mensal.
- BTC/SOL, 25/50/100 slots, meta individual/N/N, virada de ano e grupos.
- Worker REAL com BUY NEW e partial, OPEN/TP, fontes, saldos e parâmetros intactos.
- Idempotência, crash e falha503 da persistência mensal, isolamento por engine.
- Transição ATH/configuração mantém cancelamento zero-fill; fill concorrente
  e partial impedem substituição. Tudo offline, sem ordens reais de teste.
- Fixture antiga do fluxo normal foi atualizada com snapshot vazio e import da
  política MARKET; a falha foi reproduzida também no HEAD anterior à correção.

O resultado de publicação e a prova operacional atual ficam no encerramento
em `docs/evidence/coinops-monthly-level-preservation-20261102-closeout.json`.
Uma virada mensal real futura não deve ser provocada em Production como teste.
