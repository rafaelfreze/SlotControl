# Custos & Operação — fornecedores e fontes financeiras

Pesquisa de documentação oficial em 2026-09-26. Esta página documenta contratos,
limites de atribuição e evidência disponível; a existência de uma API não comprova
que sua credencial esteja configurada nem que uma sincronização tenha executado.

Hierarquia obrigatória de evidência: `REAL > ESTIMADO > RATEIO_ESTIMADO >
INDISPONÍVEL`. `MANUAL` identifica a origem de configuração; `PROJETADO`
identifica o fechamento futuro. Nenhum dos dois substitui a classificação da
evidência de custo. Ausência de invoice não significa custo zero.

## Inventário comprovado no repositório

| Serviço | Uso CoinOps | Evidência de preço | Classificação inicial |
| --- | --- | --- | --- |
| DigitalOcean | Executores do registro oficial de shards | Runbooks dos executores registram Basic Shared 1 vCPU / 1 GB / 25 GB, FRA1, USD 6/mês por Droplet | ESTIMADO, quantidade 2 x USD 6; não é fatura |
| Supabase | Projeto compartilhado OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`, Database/Auth/Realtime | Organização OnPlay PRO confirmada via MCP em 2026-09-27; invoice e parcela CoinOps ainda não confirmadas | Tarifa-base ESTIMADA; parcela exige RATEIO_ESTIMADO explícito |
| Vercel | Projeto `cripto`, `prj_GNCqXG8MVG2ePgU3y6vuosz06GoR`, web e crons | PRO, um seat e base USD 20 confirmados em consulta autenticada; oito projetos cadastrados | RATEIO_ESTIMADO da base compartilhada; consumo exato por ProjectId quando sincronizado |
| Domínio | Subdomínio canônico `cripto-flax.vercel.app` | Nenhum domínio próprio pago encontrado no escopo analisado | Nenhum custo separado presumido |
| TLS | Let's Encrypt nos executores | Nenhum serviço pago separado encontrado | Não criar despesa hipotética |

Fontes locais: `AGENTS.md`, `docs/COINOPS_LIVE_EXECUTOR_5_2.md` (somente evidência
de provisionamento; suas restrições de trading antigas não são o estado atual),
`docs/COINOPS_EXECUTOR_02_DELIVERY.md` e `apps/web/package.json`.
O segundo runbook identifica Droplet `603936458`, nome
`coinops-executor-02-fra1`. O primeiro identifica
`coinops-live-executor-fra1`, IP `46.101.104.48`; o segundo IP é
`164.90.223.159`. Esses vínculos são evidência documental inicial e devem ser
confirmados contra o registro/API antes da atribuição automática de despesa.

Os runbooks registram ausência de adicionais pagos selecionados na criação.
Isso não comprova que o mês inteiro esteja sem transferência excedente, snapshots,
backups, impostos ou alteração posterior de plano. USD 12/mês é a soma das duas
tarifas-base registradas, não custo total realizado da plataforma nem fatura.
O catálogo oficial consultado em 2026-09-26 confirma esse plano por USD 6/mês
ou USD 0,00893/h. Fonte: [preços DigitalOcean](https://www.digitalocean.com/pricing/droplets).
Cada vínculo de custo deve guardar preço unitário, quantidade, plano, resource ID,
data da evidência e URL. Um novo shard usa seu plano identificado; não herda
automaticamente USD 6 por se chamar executor.

Resend e Mercado Pago estão explicitamente fora da arquitetura atual no
`AGENTS.md`. Não criar linhas desses serviços por serem comuns em outros produtos.
Não foi localizada contratação de observabilidade externa paga no escopo atual.

### Verificação autenticada somente leitura — 2026-09-27, 00:46 UTC

- Supabase `get_project`: projeto `otdfpmsegjxpqrzisfmi`, nome OnPlay Platform,
  região `sa-east-1`, `ACTIVE_HEALTHY`, organização ID/slug
  `pzgqtvaitaawqgaabxve`.
- Supabase `get_organization`: nome OnPlay, `plan=pro`, `tier=tier_payg`.
  Isso comprova contratação PRO, não o valor faturado no mês nem add-ons.
- Supabase `list_projects` retornou apenas um projeto INACTIVE de outra
  organização, embora o `get_project` acima funcione. Portanto, essa listagem
  possui escopo insuficiente/inconsistente para determinar quantos projetos
  compartilham a assinatura PRO. Não assumir um único projeto na organização.
- Vercel `list_teams`: time OnPlay, slug `onplay`, ID
  `team_TsMRvSDiP35TCEkVAI9ZAld6`. `list_projects` retornou oito projetos,
  sem próxima página: `cripto`, `onplay-fiscal`, `personal-site`, `servnexx`,
  `zelyvara`, `onfood`, `on-play-finance` e `on-play-ads-ai`.
  São projetos cadastrados, não medição de atividade ou consumo no mês.
- Os MCPs Vercel não retornaram plano/billing. `get_project` apresenta erro de
  contrato interno (`idOrName` ausente apesar do parâmetro documentado
  `projectId`), inclusive com tentativa de compatibilidade. Não inferir PRO
  somente por haver crons ou múltiplos projetos.

Uma consulta leve a metadados `pg_class`/`pg_namespace` e
`pg_total_relation_size`, sem leitura de dados dos clientes, encontrou:

| Schema de produto | Relações | Bytes relacionais |
| --- | ---: | ---: |
| coinops | 96 | 107.429.888 |
| onfood | 119 | 13.393.920 |
| nexxfitpro | 179 | 12.386.304 |
| servnexx | 117 | 9.043.968 |
| zelyvara | 101 | 5.324.800 |
| onplay_finance | 23 | 4.014.080 |
| onplay_fiscal | 9 | 901.120 |
| Total dos sete schemas | 644 | 152.494.080 |

A participação CoinOps nessa população é **70,44856%**. Inclui tabelas,
índices e TOAST; exclui `public`, schemas privados compartilhados, Auth,
Storage, Realtime e sistemas PostgreSQL. É evidência pontual de armazenamento
relacional, **não** participação comprovada em CPU, Auth, egress, Realtime ou
na fatura inteira. Schemas preservados para histórico também consomem bytes;
sua existência não comprova produto comercial ativo.

Rateios defensáveis devem declarar o proxy escolhido. Exemplos: base Vercel
por oito projetos cadastrados (12,5%, com população atualizada periodicamente);
parcela de armazenamento relacional Supabase pelo percentual acima. Repartir
toda a assinatura Supabase por esse percentual exige identificá-lo como
proxy simplificado `RATEIO_ESTIMADO`, não como uso medido ou invoice CoinOps,
e primeiro conhecer a parcela do projeto na organização. Não aplicar
automaticamente 70,44856% da fatura global.

### Complemento autenticado do painel dos provedores — mesma execução

O agente principal confirmou no navegador já autenticado, em leitura:

- Supabase: organização OnPlay PRO, dois projetos Micro — OnPlay Platform e
  OnPlay Fiscal. Ciclo exibido **12/09/2026 a 12/10/2026**; cobrança corrente
  exibida USD 25; projeção exibida USD 34,30. O uso Micro parcial de 359 horas
  em cada projeto totaliza aproximadamente USD 9,65, ainda coberto pelo crédito
  compute. Esses valores possuem naturezas diferentes e não devem ser somados.
- Vercel: PRO, um seat, base USD 20/mês; oito projetos cadastrados. Ciclo
  **14/09/2026 a 14/10/2026**; consumo on-demand exibido USD 16,15, já após
  crédito. O valor é do time inteiro, não consumo exclusivo CoinOps; não
  subtrair o crédito uma segunda vez.
- DigitalOcean: em **27/09/2026, aproximadamente 01:00 UTC**, o overview de
  billing mostrou consumo total USD 0,67, créditos USD 4,33 e saldo estimado
  zero. O detalhamento, porém, estava atualizado somente em
  **26/09/2026, 04:41 UTC**, com `Droplets (1)` USD 0,42 e crédito USD -0,42;
  não representa os dois executores atuais. A defasagem e a diferença entre
  telas impedem atribuir USD 0,67 ou zero como custo REAL CoinOps. Manter a base
  recorrente **USD 12/mês ESTIMADO** dos dois planos identificados. Crédito
  reduz saldo a pagar, não elimina custo recorrente. Apenas Droplets apareceu
  nesse resumo; nenhum serviço adicional foi identificado, sem presumir que
  o detalhamento atrasado prove ausência definitiva de outros encargos.

Método operacional inicial escolhido, rotulado `RATEIO_ESTIMADO` e versionado:

```text
Supabase recorrente equivalente = 25 PRO + 2 x 10 Micro - 10 crédito = USD 35/mês
Parcela Platform = 35 / 2 projetos = USD 17,50/mês
Parcela CoinOps = 17,50 x 107.429.888 / 152.494.080 = USD 12,32850/mês
Vercel base CoinOps = 20 x 1/8 projetos cadastrados = USD 2,50/mês
```

O custo Supabase equivalente não transforma USD 35 em fatura cobrada agora:
é run-rate dos recursos atuais, distinto dos USD 25 correntes e USD 34,30
projetados pelo fornecedor para o ciclo em andamento. Dividir igualmente
compute/crédito entre dois projetos de mesmo plano é proxy explicitado;
adicionais, mudança de tamanho ou população exigem recalcular.

Os 901.120 bytes do schema histórico `onplay_fiscal` na Platform continuam na
população de armazenamento porque ainda ocupam esse banco, embora o produto
Fiscal tenha projeto dedicado. Não representam um terceiro projeto Supabase
nem devem adicionar outra assinatura/compute. Não confundir sete schemas
observados com sete produtos ativos.

Os USD 16,15 de Vercel on-demand podem ser atribuídos diretamente somente com
evidência `ProjectId`. Caso o ADMIN adote provisoriamente a mesma divisão
igualitária, a parcela seria USD 2,01875, sempre `RATEIO_ESTIMADO`, nunca REAL
CoinOps. Não adicionar esse rateio à despesa direta que posteriormente o
substituir. Plano base, consumo, crédito e população devem constar no snapshot.

Os ciclos dos fornecedores não coincidem com o mês-calendário da UI. Preservar
o intervalo original e não rotular todo custo do ciclo como realizado de
setembro. Apropriação proporcional ao calendário é estimativa separada, com
fórmula e período; não modificar o documento financeiro original.

## DigitalOcean — adaptador somente leitura

API base: `https://api.digitalocean.com`. Token server-side com `droplet:read`
para inventário; `billing:read` somente se habilitada leitura de billing.

| GET | Dados úteis | Uso permitido no FinOps |
| --- | --- | --- |
| `/v2/droplets/{id}` ou `/v2/droplets?per_page=200&page=N` | `id`, `name`, `region.slug`, `size.slug`, `size.price_monthly`, `size.price_hourly`, `created_at`, `networks.v4`, `features` | Tarifa atual ESTIMADA, inventário e vínculo por resource ID/shard |
| `/v2/customers/my/balance` | `account_balance`, `month_to_date_usage`, `month_to_date_balance`, `generated_at` | Contexto da conta do provedor; não atribuir tudo ao CoinOps |
| `/v2/customers/my/invoices` | Lista/identidade de faturas | Selecionar período; observar paginação |
| `/v2/customers/my/invoices/{uuid}` | `invoice_items[].amount`, `resource_id`, `resource_uuid`, `product`, `start_time`, `end_time`, `duration` | REAL somente nas linhas dos recursos oficialmente atribuídos ao CoinOps |

Valores de invoice são USD. A resposta pode conter recursos de outros produtos;
filtrar no servidor antes de persistir/expor. Linhas sem recurso atribuível exigem
rateio MANUAL documentado. Não somar invoice e tarifa mensal como duas despesas
do mesmo recurso/período. Saldo, crédito e pagamento não são consumo.
Fontes: [Droplets API](https://docs.digitalocean.com/products/droplets/reference/api/droplets/)
e [Billing API](https://docs.digitalocean.com/platform/billing/reference/api/).

## Vercel — FOCUS billing

Endpoint oficial: `GET https://api.vercel.com/v1/billing/charges` com Bearer token
server-side e parâmetros `teamId`, `from` inclusivo e `to` exclusivo em ISO UTC.
Resposta JSONL com granularidade diária; limitar cada sincronização ao período
necessário. Campos relevantes: `BilledCost`, `EffectiveCost`, `BillingCurrency`,
`ChargePeriodStart`, `ChargePeriodEnd`, `ConsumedQuantity`, `ConsumedUnit`,
`ServiceName` e `Tags` contendo `ProjectId`/`ProjectName`.

O adaptador deve aceitar somente `Tags.ProjectId` igual ao ID oficial CoinOps.
Não atribuir ao CoinOps linhas sem projeto, plano do time, seats, outro app ou
integração compartilhada. Essas parcelas precisam de configuração MANUAL de
rateio com justificativa. `BilledCost` representa base de cobrança, não prova
de pagamento. `EffectiveCost` não substitui silenciosamente o custo faturável.
Permissões disponíveis incluem Owner, Member, Developer, Security, Billing e
Enterprise Viewer; a integração de billing é documentada para Pro/Enterprise.
403, indisponibilidade de plano ou ausência de token devem aparecer como
INDISPONÍVEL, nunca custo zero.
Fontes: [FOCUS charges](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges)
e [escopos de integração](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations).

Os endpoints Marketplace de envio de invoice cobram clientes de integrações;
não servem para consultar a despesa operacional CoinOps e não devem ser usados.

## Supabase — projeto compartilhado

O catálogo público consultado oferece `GET /v1/projects/{ref}/billing/addons`
(base `https://api.supabase.com`, permissão `infra_add_ons_read`). O retorno
`selected_addons` informa compute/add-ons aplicados, com `variant.price` contendo
tipo/intervalo/amount; `available_addons` é catálogo, não contratação.
Este endpoint não é fatura e não separa consumo por schema CoinOps.
Fonte: [List project addons](https://supabase.com/docs/reference/api/v1-list-project-addons).

Contagens operacionais públicas incluem
`GET /v1/projects/{ref}/analytics/endpoints/usage.api-counts`
e `GET /v1/projects/{ref}/analytics/endpoints/usage.api-requests-count`, permissão
`analytics_usage_read`. São métricas do projeto, não custo nem uso exclusivo
de `coinops`. Fonte: [usage api counts](https://supabase.com/docs/reference/api/v1-get-project-usage-api-count).

O faturamento ocorre por organização; compute pertence a projetos, e quotas são
compartilhadas entre projetos da organização. Além disso, o projeto usado pelo
CoinOps é compartilhado com outros produtos OnPlay. Portanto, plano Pro, compute,
egress, Auth e Realtime não podem ser integralmente lançados como custo CoinOps.
Fonte: [Billing on Supabase](https://supabase.com/docs/guides/platform/billing-on-supabase).

Não foi encontrado endpoint público estável de invoice consolidada da organização
no catálogo consultado. Usar valor/rateio ADMIN MANUAL, com período, moeda,
documento de origem e justificativa, até existir integração segura apropriada.
Não copiar endpoints privados do dashboard ou session cookies para o cron.

## Tarifas-base e rateio explícito

O catálogo Supabase consultado informa Pro a partir de USD 25/mês, Micro
USD 10/mês e USD 10/mês de crédito compute. Um Pro com um único Micro resulta
em base estimada USD 25, não USD 35. O crédito pertence à organização e não pode
ser subtraído integralmente de cada projeto. Plano/add-ons atuais devem ser
confirmados; tarifa pública isoladamente não comprova contratação.
Fonte: [preços Supabase](https://supabase.com/pricing).

O Vercel Pro documenta plataforma USD 20/mês incluindo um seat de deploy e
USD 20 de crédito de uso; seats de deploy adicionais custam USD 20/mês cada.
Uso bruto dentro do crédito não deve ser somado como cobrança extra. A invoice
ou `BilledCost` já ajustado prevalece sobre uma projeção por tabela pública.
Fonte: [plano Vercel Pro](https://vercel.com/docs/plans/pro-plan).

Métodos de rateio admissíveis, sempre rotulados `RATEIO_ESTIMADO`:

- Vercel: parcela do custo fixo compartilhado dividida pelo número comprovado
  de projetos ativos, mais consumo identificado por `ProjectId`. Registrar
  população, data, seats, crédito e fórmula. Divisão igual é um proxy de uso da
  plataforma, não medição causal de CPU ou receita.
- Supabase: repartir assinatura líquida compartilhada entre projetos ativos;
  adicionar compute/add-ons do projeto após atribuição coerente de créditos;
  depois aplicar a participação de bytes relacionais `coinops` entre os schemas
  de produtos do projeto compartilhado. É proxy de recursos de armazenamento,
  não prova do percentual de Auth, CPU, Realtime ou egress; mostrar essa limitação.
- Se existir medição confiável e comparável de workload, usá-la como novo método
  versionado em vez de sobrescrever snapshots com o critério novo.

Sem denominador confiável, uma estimativa exige percentual/configuração ADMIN
explícita com justificativa; não supor que CoinOps responde por 100%. No total,
separar parcelas REAL, ESTIMADO, RATEIO_ESTIMADO e cobertura INDISPONÍVEL.

## USD/BRL e moedas de capital

Fonte cambial oficial disponível: Banco Central/PTAX. Exemplo de recurso:

```text
https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)
```

Parâmetros de período usam datas `MM-DD-YYYY`, aspas OData e `$format=json`.
Consultar janela pequena incluindo dias úteis anteriores; escolher a última
cotação disponível não posterior ao instante do snapshot, persistindo
`cotacaoVenda`, `dataHoraCotacao`, fonte e instante de coleta. Não inventar
cotação no fim de semana nem substituir o histórico ao atualizar a taxa.
Fonte: [BCB, cotações diárias USD/PTAX](https://dadosabertos.bcb.gov.br/dataset/dolar-americano-usd-todos-os-boletins-diarios).

Decisões do CoinOps: valor em USD permanece original; BRL é conversão indicativa
com fonte/timestamp, sem IOF, spread ou prova de débito bancário. Para custo
efetivamente pago em BRL, permitir lançamento MANUAL separado vinculado ao
documento, evitando dupla contagem. USDT/USDC não são USD: usar cotação explícita
da moeda/mercado ou deixar a parcela sem conversão. Nunca aplicar PTAX diretamente
a stablecoin por uma equivalência presumida de 1:1.

## Contrato de sincronização recomendado

- Apenas jobs server-side autenticados; a tela lê snapshots persistidos.
- Execução a cada seis horas e ação ADMIN explícita com cooldown são suficientes para
  custos/FX. Não acoplar ao cron de trading ou health de um minuto.
- Timeouts, limite de bytes/linhas/páginas, hosts fixos e retry finito. Respostas
  sem o escopo esperado falham antes da atribuição financeira.
- Um fornecedor com erro não derruba a sincronização dos outros nem trading.
- Preservar último dado válido, idade, origem e erro sanitizado; não substituir
  valor conhecido por zero ao falhar API.
- Snapshot mensal guarda valores originais, conversões e taxa utilizada,
  quantidades operacionais, método de projeção e cobertura incompleta.
- Preço de plano/recorrência é ESTIMADO; divisão compartilhada é RATEIO_ESTIMADO;
  invoice/consumo confirmado é REAL; entrada do operador mantém origem MANUAL;
  ausência sem estimativa defensável é INDISPONÍVEL. Fechamento futuro continua
  PROJETADO, sem transformar a estimativa em cobrança real.
- Alertas de custo só notificam ADMIN e têm chave de deduplicação por
  fornecedor/recurso/período/tipo. Não alteram admission gate nem executor.

## Limites da evidência desta pesquisa

Foram lidos runbooks, documentos públicos oficiais e metadados autenticados via
MCP na verificação acima. O agente principal acrescentou a observação autenticada
de planos/custos correntes dos dashboards, com os períodos e limites descritos.
Nesta pesquisa/adaptadores, nenhum token foi acessado ou exibido, nenhuma fatura
foi baixada, nenhum recurso/credencial foi criado
e nenhuma configuração dos fornecedores foi alterada. A consulta pública real
ao BCB foi concluída em 2026-09-27 às 00:56 UTC após corrigir a serialização
OData de espaços (`%20`, não `+`): USD/BRL PTAX venda 5,1991,
observada em 2026-09-25 às 16:10:17.447 UTC. O adaptador de USDT/BRL também
respondeu; sua cotação é independente da PTAX. Isso valida a consulta pública,
não substitui a evidência de sincronização no runtime Production.
Sincronização automática só pode ser declarada ativa após execução server-side
comprovada; configuração de um adaptador isoladamente não satisfaz esse gate.
