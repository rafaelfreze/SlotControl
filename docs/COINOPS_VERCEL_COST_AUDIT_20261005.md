# Vercel — auditoria e redução segura de custo (05/10/2026)

## Fontes e períodos

Leitura autenticada de Billing, Upcoming Invoice, Usage, Observability/Query e
Deployments da equipe OnPlay, aproximadamente 05/10/2026 23:50 UTC.
Os valores abaixo são consumo acumulado/estimativa da próxima fatura, não pagamento.
Usage tem atraso de ingestão e arredondamento; não substituir pelos contadores de
Observability, que usam outra janela e outro universo de eventos.

- Ciclo 14/set–14/out: infraestrutura US$88,98; Pro US$20; crédito US$20 já consumido.
  Excedente US$68,98; próxima fatura acumulada US$88,98.
- Outubro até a leitura: infraestrutura US$26,64 (Fiscal US$13,56, CoinOps US$12,68,
  outros US$0,40 aproximadamente). Plano mensal não é o rateio parcial US$4 mostrado no filtro.
- Usage “Last 7 days”, 28/set–05/out: infraestrutura US$45,59;
  Fiscal US$22,49; CoinOps US$22,23. A janela inclui dia parcial.
- Ciclo anterior 14/ago–14/set: infraestrutura US$44,06; Fiscal US$34,41; CoinOps US$1,17.

| Projeto | Ciclo atual | Outubro parcial | Usage últimos 7 dias |
|---|---:|---:|---:|
| Fiscal | US$49,73 | US$13,56 | US$22,49 |
| CoinOps | US$36,53 | US$12,68 | US$22,23 |
| OnFood | US$1,00 | US$0,20 | US$0,32 |
| Zelyvara | US$0,64 | US$0,01 | US$0,02 |
| OnPlay Finance | US$0,45 | US$0,12 | US$0,23 |
| Personal Site | US$0,43 | US$0,04 | US$0,09 |
| ServNexx | US$0,22 | US$0,04 | US$0,20 |
| OnPlay Google Ads | US$0,00 arredondado | Sem linha cobrável exibida | US$0,00 arredondado |

Arredondamentos por projeto podem divergir do total em centavos. Fiscal e
CoinOps concentram aproximadamente 96,9% do ciclo; não alterar os demais
produtos por terem usage incluído ou custo pequeno nesta leitura.

| Recurso no ciclo atual | Custo acumulado |
|---|---:|
| Observability Events (27.550.244 eventos) | US$33,06 |
| Fast Origin Transfer (38,42 GB) | US$15,29 |
| Build CPU Minutes (67h52min) | US$14,25 |
| Fluid Active CPU (62h02min) | US$13,21 |
| Fluid Provisioned Memory (639,831 GB-h) | US$11,27 |
| Function Invocations (2.931.387) | US$1,76 |
| CDN additional CPU | US$0,14 |
| ISR writes | US$0,01 |

Fast Data Transfer 65,34 GB e CDN 2.063.289 requests estavam dentro do incluído.
Imagens, ISR reads e demais itens sem cobrança visível não são drivers relevantes
nesta leitura. Não há Drain externo pago configurado. Supabase Storage não é Vercel Storage.

## US$9,92: origem exata e projeção

O export oficial FOCUS já persistido pelo coletor FinOps Fiscal (consulta somente
leitura a `public.finops_actual_costs`, projeto Fiscal confirmado) cobre quatro dias
completos: 01/out 07:00–05/out 07:00 UTC. Não é o ciclo inteiro.

- Observability: CoinOps US$7,706447; Fiscal US$2,084966; demais US$0,128566;
  total arredondado US$9,92. CoinOps responde por cerca de 77,7%.
- Infraestrutura total: US$22,571581 / 4 = cerca de US$5,64/dia.
- CoinOps: US$10,732093 / 4 = cerca de US$2,68/dia, US$83,17 em 31 dias.
- Fiscal: US$11,501336 / 4 = cerca de US$2,88/dia, US$89,14 em 31 dias.
- Projeção de infraestrutura em 31 dias: aproximadamente US$174,93. Estimativa
  condicional ao mesmo ritmo, especialmente desenvolvimento/builds; não cobrança confirmada.
- Observability da equipe: cerca de US$2,48/dia, US$76,88 em 31 dias.

No filtro outubro, 98,6% dos eventos CoinOps são External APIs: 7.469.543 eventos.
Na última semana, Supabase é o principal destino (~10 milhões de requests), seguido
dos executores (658 mil / 545 mil / 152 mil) e mercado público Binance (~141 mil).
Observability Plus cobra por eventos de requests, não por quantidade de texto em
`console.info`. Remover logs não elimina esses milhões de eventos.

## Funções, crons e builds

CoinOps, Production, última semana: LIVE execution ~10.085 invocações, P75 26s,
CPU total ~6h; Watchdog ~10.083, P75 172ms, CPU ~7min; Capacity ~10.081,
P75 1,04s, CPU ~16min; Push ~10.081, P75 870ms, CPU ~15min.
Saúde do Ativo 335 execuções, P75 3,33s, CPU ~2min. Custos por função não são
fatura individual: a Vercel agrega recursos por projeto. Duração de parede não é CPU faturada.

Fiscal, última semana: site público ~216 mil chamadas / ~6h CPU;
Google Merchant ~2 mil / ~1h CPU; proxy de mídia ~33 mil / ~1h CPU;
imagem Meta ~39 mil / ~47min CPU. Origin Transfer: imagem Meta 7,4GB;
proxy de mídia 2,22GB; site público 2,04GB. Os handlers já têm cache e fronteiras
de publicação/assinatura; alterar esses mecanismos requer prova de cache misses,
não presumir que toda chamada é redundante.

Deployments Fiscal até a captura: outubro 124, 118 SHAs distintos;
última janela de sete dias 145 (144 Production, 1 Preview), todos READY.
Semana anterior 21–27/set: 42. Cinco SHAs tiveram seis republicações adicionais.
As seis têm `source=redeploy`, não um novo disparo Git automático; o autor da
conta não distingue clique humano de chamada autorizada por agente.
Builds Fiscal em outubro custaram US$3,70; no export de quatro dias completos,
832 minutos de CPU = US$2,912. Não existe atribuição faturada das seis repetições
no export usado. Não converter os 642s de duração dessas republicações em cobrança
de CPU nem apresentar média por build como custo real do subconjunto.
Não há pipeline local duplicando Git/Vercel (`.github` ausente nos dois checkouts).
SHA repetido pode ser legítimo após mudança de ambiente; não bloquear redeploys
de recuperação nem criar filtro cego por SHA. Publicação desta mudança usa somente push Git.

## Classificação e implementação

| Oportunidade | Classe | Decisão |
|---|---|---|
| Sete UPDATEs de alerta vazio por shard/minuto | SAFE_TO_OPTIMIZE | Um SELECT de alertas abertos; batch apenas dos presentes/ativos |
| Payload completo de todos os engines no log saudável/minuto | SAFE_TO_OPTIMIZE | Sumário sanitizado 2/h; retry/restart/recovery/failure sempre registrado |
| Observação saudável do coletor gravada a cada 5min | SAFE_TO_OPTIMIZE | Observar 1/min, transições imediatas, checkpoint saudável 30min |
| Supervisão Codex de 2h duplicando checks internos | SAFE_TO_OPTIMIZE | Automação existente no PC convertida para diária às 09:30, releitura confirmada; nenhuma rotina duplicada |
| Cache de snapshots financeiros/leitura durante reconciliação | REQUIRES_ANALYSIS | Não mudar nesta entrega; risco de race/fill/ownership |
| Desabilitar Observability Plus/retirar retenção | REQUIRES_ANALYSIS | Não aplicado: preservar diagnóstico de incidentes recentes |
| Crons Shadow pausados | REQUIRES_ANALYSIS | Manter guardas, histórico e compatibilidade; ausência atual de engine ativo não prova retirada definitiva |
| Redeploys Fiscal com SHA repetido | REQUIRES_ANALYSIS | Seis identificados; propósito de cada um não comprovado |
| Watchdog/LIVE/push/Capacity e gates de segurança | DO_NOT_TOUCH | Cadência e garantias preservadas |

### Antes → depois, sem promessa de fatura menor já medida

Para três shards saudáveis, sem alertas:

- Capacity alerts: 7 requests por shard/min → 1; 30.240 → 4.320 requests/dia.
  Zero UPDATE/UPSERT de alerta no caminho saudável. Telemetria e heartbeat continuam
  persistidos a cada minuto; alertas reais permanecem atualizados e fail-closed.
- Redução determinística: 25.920 requests/dia, 803.520 em 31 dias. Ao preço atual
  de US$1,20/milhão, cerca de US$0,96/mês só em eventos externos observados,
  se o número de shards e o estado saudável permanecerem. CPU/memória e Supabase
  podem também cair, mas não foram quantificados como economia faturada.
- Observação do coletor: aproximadamente 288 → 48 checkpoints saudáveis/dia;
  falha/recovery não espera o intervalo. Último sucesso da fonte, TTL e stale
  continuam independentes e não são prolongados pela observação.
- Logs saudáveis LIVE: aproximadamente 1.440 → 48/dia; payload financeiro removido
  do log. Eventos financeiros, fills, gains e checkpoints do ledger intactos.
  Falhas, retries, transições de ciclo e recovery não são amostrados.
- Economia de Observability projetada mínima dos requests removidos: cerca de
  US$0,97/mês. Não vender isto como redução grande dos US$33,06 acumulados.

### Cadências CoinOps preservadas

Watchdog, LIVE execution, Capacity e Push: 1 minuto. Market regime e Shadow gate:
5 minutos. FinOps e LIVE monitor: 6 horas. Saúde do Ativo: FAST 30min,
STRUCTURAL 6h, DEVELOPMENT 24h; GET não coleta e respeita TTL.
Não consolidar safety jobs com dependências externas lentas, pois uma falha
monopolizaria o laço de proteção. Não reiniciar executores por mudança somente web.

### Fiscal: classificação de todos os crons atuais (nenhuma alteração aplicada)

| Cron | Cadência | Papel / limite |
|---|---|---|
| fiscal-integration-webhooks | 10min | CRÍTICO: fila fiscal e checkpoints |
| marketplace-personalization | 5min | OPERACIONAL: pós-venda/pedidos |
| google-merchant | 5min | OPERACIONAL: channel sync + conversões/retentativas Ads; não só feed |
| whatsapp-flows | 5min | OPERACIONAL: conversa/filas |
| shopee / mercado-livre | 10min | OPERACIONAL: integrações e pedidos |
| instagram-stories | 15min | OPERACIONAL: publicações agendadas |
| email-delivery | 2h | OPERACIONAL: entrega transacional |
| financial-report | 1h | OPERACIONAL: sincronização financeira |
| meta-catalog | 6h | OPERACIONAL: catálogo/publicação |
| accounting-monthly | diária | ADMINISTRATIVO: fechamento verifica período; nome não prova desperdício |
| finops-daily | diária | ADMINISTRATIVO: custo real |
| ncm-sync | semanal | ADMINISTRATIVO: tabela fiscal |

Não foi comprovado cron Fiscal inútil. Não reduzir retry/latência comercial/fiscal
por inferência. A automação local horária de NF-e é proteção distinta, não substitui
nem duplica automaticamente a fila fiscal server-side.

## Validação e fontes reproduzíveis

- Novas regressões e testes relacionados: 14/14 aprovados. Suítes de capacidade,
  Watchdog e Saúde do Ativo: 119 aprovados, 51 SQL ignorados por exigir banco
  efêmero local, zero falhas. Nenhum teste SQL executado em Production.
- Regressões de overhead disponíveis em `apps/web`: `npm run test:finops-overhead`.
- Typecheck, lint direcionado e build aprovados. Build mantém avisos existentes
  de Supabase/Edge e CSS `start/end`; nenhuma correção alheia foi incorporada.
- Automação diária aplicada pelo gerenciador oficial do PC e confirmada pela
  releitura do registro persistido; ver `COINOPS_PRODUCTION_MONITOR_2H.md`.
- Billing: https://vercel.com/onplay/~/settings/billing
- Próxima fatura: https://vercel.com/onplay/~/settings/invoices/upcoming
- Usage: https://vercel.com/onplay/~/usage (filtros de período e projeto).
- Observability CoinOps: https://vercel.com/onplay/cripto/observability
- Observability Fiscal: https://vercel.com/onplay/onplay-fiscal/observability
- Build Diagnostics Fiscal: https://vercel.com/onplay/onplay-fiscal/observability/build-diagnostics
- Preço/definição de eventos: https://vercel.com/docs/manage-and-optimize-observability

Reprodução do US$9,92: agregar `sum(amount_usd)` dos registros oficiais FOCUS do
provedor `vercel`, período `2026-10-01`, produto `Observability Events`, agrupando
por project ID; conferir `metadata.focus` e intervalo de uso 01/out 07:00–05/out
07:00 UTC antes de comparar com Usage. Não somar snapshots repetidos nem incluir
a tarifa Pro rateada na infraestrutura. Consulta somente leitura no projeto
Fiscal, schema `public`, com referência do produto confirmada.

```sql
select metadata->'focus'->'Tags'->>'ProjectName' as project,
  sum(amount_usd) filter (
    where metadata->'focus'->>'ServiceName'='Observability Events'
  ) as observability_usd,
  sum(amount_usd) as infrastructure_usd,
  min(metadata->'focus'->>'ChargePeriodStart') as period_start,
  max(metadata->'focus'->>'ChargePeriodEnd') as period_end,
  max(created_at) as collected_at
from public.finops_actual_costs
where provider='vercel' and period='2026-10-01'
  and metadata->'focus'->'Tags'->>'ProjectId' is not null
group by 1;
```

A consulta reproduzível é somente leitura. Registros sem ProjectId incluem o
plano Pro rateado e não entram na soma de infraestrutura por projeto.

Avaliação analítica: compartilhar com ressalvas. Dados oficiais acumulados foram
reconciliados, mas projeções não são fatura, janelas parciais não são comparações
equivalentes e o custo real das seis republicações não possui atribuição individual
nas fontes consultadas. Não prometer economia adicional por estimativa de duração.

## Guardas e comprovação pós-publicação

Produto modificado: somente CoinOps / SlotControl, Vercel `cripto`, schema `coinops`,
Supabase `otdfpmsegjxpqrzisfmi`. Fiscal foi auditado somente leitura, separado.
Nenhuma migration, alteração de plano, secret, runtime de VPS, ordem ou estratégia.
Preservar RLS, leases, idempotência, capital, TP/NEXT BUY e histórico.

Baseline desta auditoria: 16 ACTIVE REAL, 3 executores saudáveis (7/7/2), Watchdog
HEALTHY, zero incidente aberto, zero critical, zero kill switch. Runtime comum
`65f2e382a441d5c51509d06a17e6ddfe74cef60c`, Node24.21.0.
Revalidar após deploy com leitura fresca de telemetria, Watchdog, slots/TP/NEXT BUY,
fills pendentes, incidentes e logs dos crons. Não chamar cron autenticado manualmente
nem criar trade/push para smoke. A economia faturada exige janela posterior comparável;
o readback imediato comprova funcionamento, não redução da próxima fatura.
