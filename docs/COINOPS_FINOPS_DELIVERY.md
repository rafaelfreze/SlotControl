# CoinOps — Custos & Operação / entrega FinOps

Data do checkpoint: 27/09/2026 (UTC). Produto: CoinOps Automation.
Projeto Supabase: `otdfpmsegjxpqrzisfmi`; schema: `coinops`.
Vercel: `cripto`, domínio `https://cripto-flax.vercel.app`.

Este documento registra implementação, evidência, limites e procedimento de
operação. O fechamento remoto abaixo foi observado em 27/09/2026, entre 01:04
e 01:23 UTC. Código/teste local não é confundido com evidência de Production.

## 1. Escopo e separação financeira

O módulo `/custos-operacao` é exclusivo do ADMIN proprietário do operador.
VIEWER/clientes não recebem navegação nem acesso à API/dados internos.

Há três domínios distintos:

- **Capital monitorado:** caixa das moedas acompanhadas e posições pertencentes
  às contas Binance, observado pelo CoinOps; não é patrimônio nem receita da plataforma.
- **Resultado das estratégias:** P&L realizado e aberto do ledger automático,
  sem transformar aportes/ajustes em ganho de trading.
- **Custo operacional:** recursos e serviços utilizados pela plataforma, com
  atribuição explícita quando compartilhados com outros produtos OnPlay.

FinOps não altera Strategy Engine, ordens, TP, NEXT BUY, ganhos, ciclos,
recovery, watchdog, admission gate ou infraestrutura contratada.

## 2. Arquitetura implementada

```text
ADMIN autenticado ── GET /api/coinops-finops ── snapshots persistidos
       │
       ├─ POST action=SYNC ── lease + cooldown ─┐
       └─ ajuste manual ── auditoria ─────────┤
                                              ↓
Cron próprio autenticado ── syncFinops ── fontes read-only / estimativas
                                              ↓
                            modelo + FX + capital + capacidade
                                              ↓
                         publicação atômica + snapshot imutável
```

Implementação principal em `apps/web/lib/coinops-finops/`:

| Arquivo | Responsabilidade |
| --- | --- |
| `types.ts` | Contratos serializáveis e classificação financeira |
| `model.ts` | Autorização de propriedade, projeção, conversão, rateio e validação manual |
| `capital.ts` | Agregação pura com precisão decimal nativa e detecção de inconsistências |
| `capital-server.ts` | Leituras escopadas/paginadas do ledger e snapshot read-only de conta |
| `providers.ts` | Adaptadores oficiais de FX, inventário/tarifa DigitalOcean e uso Vercel |
| `server.ts` | Autorização, leitura persistida, sincronização, alertas e publicação |
| `fx-repair.ts` | Revalorização de snapshot incompleto, sem nova coleta privada |

A tela lê apenas dados já persistidos. Atualizar/renderizar a página não dispara
consultas de billing, Binance nem reconciliação.

## 3. Frequência e uso administrativo

Cron próprio: `/api/cron/coinops-finops`, expressão `17 */6 * * *`, UTC,
autenticado pelo `CRON_SECRET` existente. Duração máxima: 300 segundos.
Não é o cron de trading/watchdog e não compartilha seus locks.

O botão **Atualizar dados** usa o mesmo worker e separa dois relógios:

- Fornecedores/billing: cooldown móvel de seis horas desde a última coleta
  externa publicada. A virada de uma janela UTC não permite contorná-lo.
- Capital/infraestrutura: nova leitura administrativa, limitada a uma coleta
  por 60 segundos, sob a mesma lease. Consulta ledger, registry, telemetria e
  snapshots read-only das contas pelos executores atribuídos. Não envia ordens,
  não altera capital e não executa reconciliação com escrita.

Durante execução concorrente retorna `IN_PROGRESS`; no cooldown operacional,
`FRESH` com `nextOperationalSyncAt`. Fora dele, atualiza a operação mesmo com
billing em cooldown e retorna `OPERATIONAL_UPDATED` ou `PARTIAL`. Snapshots
`OPERATIONAL:<owner>` usam `p_external:false`, mantendo `externalCapturedAt` e
`last_external_synced_at`. `operationalCapturedAt` identifica a coleta, não
substitui a evidência `observedAt`/heartbeat de cada fonte. Uma falha permanece
parcial/indisponível; não converte saldo antigo em saldo atual.

A UI aguarda o GET do snapshot persistido após o POST antes de exibir sucesso e
novos números. Recarregar a página só lê snapshots, sem polling de fornecedores.
Datas de coleta operacional e fornecedores ficam separadas no topo. O botão
**Início**, visível e fixo no mobile, retorna a `/automacao` preservando ambiente,
conta e mercado em parâmetros validados, sem URL externa de retorno.
O cabeçalho mobile usa `position:fixed` com espaço e safe-area reservados na
própria rota: `sticky` é insuficiente porque o layout compartilhado possui
`body` com overflow oculto. Não alterar esse layout global para corrigir FinOps.

Somente `syncAllFinops`, chamado pelo cron autenticado, habilita o modo interno
`SCHEDULED`. Dentro da mesma lease, ele verifica se já existe coleta externa na
janela UTC atual (00–06, 06–12, 12–18 ou 18–24). Se sim, retorna `FRESH`; se não,
executa e publica com a chave idempotente `SIX_HOUR:n` e fencing existentes.
Assim, uma coleta manual às 01:05 não adia o cron das 06:17; um atraso do cron
anterior de 06:17:00 para 06:17:30 não faz pular o próximo das 12:17. Uma coleta
manual às 06:05 já cobre aquela janela: o cron das 06:17 não repete e o das
12:17 volta a executar. Não há polling adicional nem novo acesso externo no
page load. O `nextSyncAt` do modo agendado informa a próxima janela elegível;
o disparo regular continua no minuto 17.

A primeira sincronização é permitida se ainda não houver coleta. O browser
não pode enviar `trigger`, `force`, tenant, operador ou outras opções para contornar os guardas.

Salvar uma configuração manual recria o snapshot a partir dos dados persistidos,
sem chamar Binance/billing e sem adiar o próximo refresh externo. Se outro worker
detiver o lease, a configuração fica salva e o snapshot pode aguardar a coleta
seguinte; não se dispara um segundo worker concorrente.

As métricas de CPU/RAM/capacidade na tela são observações do instante do snapshot
FinOps, não um monitor LIVE de segundo a segundo. O painel operacional continua
sendo a fonte de saúde atual. Idade e origem devem permanecer visíveis.

## 4. Fontes canônicas de capital

Correção de 28/09/2026: o retorno antecipado `FRESH` do cooldown de fornecedores
impedia ler o aporte novo no FinOps. A atualização operacional independente acima
corrige essa causa, sem invalidar billing a cada clique. Regressões executam o
worker real com dependências simuladas: separação dos relógios, limite de 60s,
concorrência, fencing, erro parcial, recuperação específica do capital e reparo FX.
O painel testa espera pelo snapshot confirmado, erro HTTP/JSON incompleto,
clique duplicado e navegação de retorno segura. Validação Production deve usar
apenas leitura/sincronização FinOps, nunca aporte real nem envio de ordens.

Não confundir esse snapshot com `Capital em posições` na Automação: esse último
é o custo comprometido das posições já compradas (ledger), não todo o aporte.
Uma NEXT BUY residente ainda sem fill compõe a reserva/exposição, não as posições.
Aporte pendente em OPEN não aumenta quantidade nem custo da posição atual.

Fontes: `exchange_accounts`, `trading_engines`, `robot_v1_live_runs`,
`robot_v1_live_slots`, `robot_v1_live_slot_accounts` e
`robot_v1_live_orders`, limitadas ao operador autorizado, tenant e ambiente REAL.

Durante a sincronização externa, o helper read-only existente
`operatorAccountSnapshot` consulta o executor **atribuído à conta**. Há no máximo
duas contas consultadas em paralelo e uma observação por conta candidata na rodada.
Não consulta histórico Binance completo, não envia ordens e não aciona reconciliação.

Definição atual, por conta/moeda de cotação:

```text
capital monitorado = quote livre + quote bloqueado Binance
                    + valor de mercado das posições base pertencentes ao CoinOps
```

O saldo de uma carteira não é repetido por motor. Não se soma novamente:

- alocação dos slots ou limite de capital;
- saldo base da carteira já representado pelas posições;
- P&L ou reserva BUY já contidos no patrimônio observado.

Capital por mercado representa posição/reserva/resultado do respectivo ledger,
não uma divisão arbitrária de toda a carteira. A UI mantém moedas nativas distintas.
Outros ativos Binance que não pertencem ao escopo monitorado são explicitamente
excluídos/não valorizados; o total não pretende avaliar todo o patrimônio Binance.

P&L realizado usa `market_pnl_quote - fees_quote`; P&L aberto é posição marcada
a mercado menos custo comprometido. Ganhos históricos do ledger não são apagados.

## 5. Qualidade e indisponibilidade de capital

Agregação financeira nativa usa decimal fixo de 12 casas com `bigint` interno;
os contratos de saída são serializáveis, sem `bigint` no JSON.

O total fica indisponível/partial quando houver, por exemplo:

- carteira, preço ou reconciliação sem evidência fresca na coleta;
- erro na atualização da carteira, mesmo que uma validação anterior pareça recente;
- ciclo ambíguo, conjunto incompleto dos 25 slots ou cruzamento indevido de engine/conta;
- ordem residente conhecida ausente do snapshot (possível fill entre observações);
- posição própria maior que o saldo base observado;
- conta sem shard ou mercado REAL configurado;
- sobreposição base/quote que torne a soma ambígua.

A validação de onboarding persistida é apenas fallback identificado pela origem
e timestamp, nunca saldo atual presumido. Ausência de evidência não vira zero.
Zero é válido apenas quando uma observação completa efetivamente comprova zero.

O contrato do snapshot de conta existente cobre até dois mercados na mesma quote.
Layouts futuros não suportados ficam parciais até extensão segura desse contrato.

## 6. Inventário de serviços e custos iniciais

Os executores são descobertos pelo registry oficial, sem lista fixa de contagens.
Um novo shard aparece com preço indisponível até haver evidência de plano/recurso;
não recebe automaticamente a tarifa de outro executor.

| Serviço | Evidência inicial | Classificação |
| --- | --- | --- |
| DigitalOcean, Executor 01 | Plano comprovado Regular 1 vCPU / 1 GiB / 25 GB, FRA1, USD 6/mês | ESTIMADO / DOCUMENTED |
| DigitalOcean, Executor 02 | Mesmo plano comprovado, Droplet `603936458`, USD 6/mês | ESTIMADO / DOCUMENTED |
| Supabase compartilhado | PRO + dois Micro menos crédito; proxy de parcela Platform e bytes CoinOps | RATEIO_ESTIMADO / MANUAL |
| Vercel compartilhado | PRO, um seat, oito projetos cadastrados; parcela igualitária explícita | RATEIO_ESTIMADO / MANUAL |

Tarifa-base DigitalOcean conhecida: USD 12/mês para os dois recursos comprovados;
não é fatura nem prova de pagamento. Créditos/saldo a pagar não eliminam o custo
recorrente. Extras não identificados não são inventados como zero confirmado.

Supabase, proxy documentado:

```text
Base recorrente equivalente organização = 25 + (2 × 10) - 10 = USD 35
Platform = 35 / 2 = USD 17,50
CoinOps = 17,50 × (107429888 / 152494080) ≈ USD 12,32850/mês
Parcela final sobre a base da organização ≈ 35,2243%
```

O denominador é armazenamento relacional dos schemas de produto observados;
não é medição de CPU/Auth/Realtime/egress. É rateio administrativo, não invoice.

Vercel: base USD 20; parcela inicial 1/8 = 12,5%. Uso on-demand observado no time:
USD 16,15 já após crédito, no ciclo 14/09–14/10/2026. O rateio provisório desse uso
é estimado; não atribuir toda a cobrança do time ao CoinOps.

Detalhes das consultas autenticadas, APIs, preço, origem e limitações estão em
[`COINOPS_FINOPS_PROVIDERS.md`](COINOPS_FINOPS_PROVIDERS.md).
Resend, Mercado Pago, domínio próprio e observabilidade paga separada não foram
adicionados como despesas hipotéticas.

## 7. Hierarquia de evidência

`REAL > ESTIMADO > RATEIO_ESTIMADO > INDISPONIVEL` é classificação do dado.
`API`, `MANUAL` e `DOCUMENTED` identificam a origem, separadamente.
`PROJETADO` descreve o horizonte futuro, não prova de cobrança.

Um valor manual não pode ser marcado REAL sem valor realizado e justificativa.
Rateio exige percentual explícito. Moeda, limites numéricos, período e origem
são validados no backend; campos de role/tenant enviados pelo browser são ignorados.

Consumo REAL atribuível ao projeto continua no subtotal mesmo sem tarifa fixa
conhecida. Quando há tarifa/projeção maior, apenas a diferença não realizada
compõe a parcela estimada; não se soma invoice e tarifa inteira duas vezes.

Totais exibem cobertura parcial quando houver parcelas desconhecidas. O subtotal
conhecido não é apresentado como fatura total completa. Custos médios por conta/motor
usam essa mesma cobertura e não presumem que serviço desconhecido seja gratuito.

## 8. Projeção e ciclos dos fornecedores

Com tarifa fixa e variável conhecida:

```text
projeção = tarifa recorrente
         + variável observada × duração do ciclo / tempo decorrido na observação
```

O resultado respeita o piso de custo REAL conhecido quando aplicável. Sem tarifa
fixa conhecida, o consumo REAL isolado é subtotal conhecido, não previsão de
uma tarifa desconhecida. O cálculo não fabrica consumo futuro.

`billing_period_start` e `billing_period_end` preservam o ciclo do fornecedor;
se ausentes, usa-se o mês-calendário UTC. Ambos devem existir juntos, com fim
posterior ao início. A fonte atual Vercel aproxima as datas civis exibidas a UTC,
limitação registrada na evidência.

A variável congelada é projetada com `synced_at` da observação, não com o relógio
avançando: sua previsão não cai artificialmente só porque ninguém atualizou o valor.
Fora do ciclo, variável/realizado antigos ficam indisponíveis; a tarifa-base
conhecida permanece. Revisar período e consumo manualmente quando não houver API.

Os snapshots são agrupados por mês de captura para histórico. Não constituem
apropriação contábil de invoices por mês nem prova de custo pago no mês-calendário.

## 9. FX e preservação histórica

- USD → BRL: BCB/PTAX venda, última observação válida não futura, janela máxima de sete dias.
- USDT → BRL: cotação pública Binance Spot `USDTBRL`, distinta de USD; idade máxima de 15 minutos na captura.
- BRL permanece BRL. Outras moedas sem cotação explícita não são consolidadas por aproximação.

Cada cotação conserva valor, fonte, `observedAt` e `fetchedAt`. Cada snapshot
persiste as conversões e taxas usadas naquele instante; nova cotação não recalcula
o histórico antigo. Conversão PTAX é indicativa, sem spread/IOF ou débito bancário.
Falha em uma fonte não elimina uma cotação válida independente; parcela sem FX fica
indisponível, preservando o valor original.

Correção do smoke: sucesso parcial das fontes de FX não equivale a sincronização
completa. Se uma moeda efetivamente usada estiver sem conversão, o status é
`PARTIAL` e o consolidado permanece indisponível. O botão ADMIN pode reparar
apenas FX durante o cooldown da coleta externa: lease FinOps, intervalo mínimo
de um minuto entre tentativas e novo snapshot `FX_REPAIR:<owner>`. Essa reparação
não chama carteira privada, billing, registry ou reconciliação; preserva o
snapshot original, valores nativos e timestamps de carteira/telemetria.
`externalCapturedAt` impede que a reparação faça observações antigas parecerem
recém-coletadas. A publicação usa `p_external=false` e não reinicia nem contorna
o cooldown de leituras privadas. Sete regressões adicionais comprovam o caminho,
incluindo tentativa parcial por indisponibilidade do provedor.

## 10. Capacity Manager × custo

O FinOps lê registry/amostras persistidas do Capacity Manager. Exibe custo por
executor, CPU/RAM, peso Binance, headroom, fila, heartbeat e recomendação de expansão.
Essas observações têm timestamp de snapshot; não alteram a decisão de admissão.

Orçamentos de IPs diferentes não são somados como um único limite. Cenários de
10/50/100 contas adicionais são ilustrativos; a hipótese de dois motores por conta
é explicitada, não uma obrigação de produto. Quantidade/custo de novos executores
fica indisponível enquanto não houver capacidade incremental comprovada.
Visualizar custo não provisiona recursos nem migra contas.

## 11. Persistência, RLS e segurança

Migration: `20260927005603_add_coinops_finops_admin.sql`.
Aplicação no projeto oficial informada pelo agente principal; revisão/fechamento
remoto devem conservar a evidência da aplicação na seção final.

Tabelas novas:

- `finops_services`: configuração/evidência atual de custos;
- `finops_service_revisions`: histórico before/after imutável;
- `finops_snapshots`: observações financeiras imutáveis;
- `finops_alerts`: incidentes administrativos deduplicados;
- `finops_sync_state`: lease/cooldown/resultado, independente do trading.

Todas têm RLS habilitada e forçada. `anon` e `authenticated` não recebem acesso
direto; VIEWER não lê custos nem funções administrativas. A API valida `getUser`,
nega role VIEWER e exige operador ACTIVE pertencente ao usuário e tenant oficial.
Autorizar ADMIN não depende apenas de metadata ou de um nome de role.

`service_role` tem grants explícitos mínimos; broad default privileges são
revogados antes da concessão necessária. Snapshots/revisões não têm UPDATE/DELETE,
e triggers adicionais rejeitam mutações até sob SQL privilegiado normal.
Triggers validam tenant/operador e vínculo de revisão/alerta ao serviço correto.

Funções são `SECURITY INVOKER`, com `search_path` restrito e EXECUTE exclusivo
do backend. Endpoints retornam `no-store`, erros sanitizados e exigem mesma origem
no POST. Nenhum secret de billing ou Binance entra no payload/frontend/documentação.

## 12. Concorrência e recovery do próprio FinOps

`finops_claim_sync` adquire lease de seis minutos por operador, maior que o limite
de 300 segundos da função. Outro operador não é bloqueado pelo mesmo lease.
Execução concorrente para o mesmo operador não faz segunda coleta.

`finops_finish_sync` verifica owner/lease não expirado e publica snapshot/estado
na mesma transação. Worker expirado não publica resultado nem sobrescreve o sucesso
do sucessor. Crash deixa o lease expirar; não há pedido Binance de escrita para
reexecutar. Idempotência adicional: chave única de snapshot por operador.

Falha de FinOps pode impedir temporariamente dados novos deste módulo, mas não
adquire locks nem altera estados/tabelas operacionais do trading.

## 13. APIs automáticas e limites atuais

Adaptadores implementados:

- DigitalOcean GET `/v2/droplets`: vincula recurso ao IP primário exato do registry
  e recupera plano/tarifa ESTIMADA, paginado e com host fixo.
- Vercel GET `/v1/billing/charges`: parser FOCUS, período e `ProjectId` exatos;
  ignora outros projetos e linhas compartilhadas sem atribuição.
- BCB/PTAX e Binance ticker público para FX.

Tokens `FINOPS_DIGITALOCEAN_TOKEN` e `FINOPS_VERCEL_TOKEN` não foram configurados
nesta entrega. A existência dos adaptadores não comprova billing automático
ativo. As estimativas iniciais independem desses tokens e mantêm fonte declarada.

Supabase e Vercel compartilhados permanecem configurados MANUAL, com preço/plano
comprovado e rateio explícito. Não há scraping contínuo nem cookies de sessão no cron.
Ao habilitar billing por API posteriormente, substituir a parcela de consumo
rateada pela direta quando equivalente; não adicionar ambas para a mesma despesa.

Falha/remoção de token invalida consumo API corrente. Tarifa conhecida pode ser
preservada como estimativa, com falha/idade visíveis. Nenhuma indisponibilidade
é convertida em custo zero. Adaptadores têm timeout, limites de resposta/paginação
e erros sanitizados, sem expor credenciais.

## 14. Alertas

Tipos persistidos: `COST_INCREASE`, `BILLING_SYNC_FAILED`, `UNEXPECTED_COST`,
`SERVICE_LIMIT_WARNING`, `EXECUTOR_COST_CHANGE`.

Deduplicação por operador, serviço/plataforma, código e período. A tela ADMIN
mostra os incidentes. Eventos financeiros não interrompem trading e não alteram
Capacity Manager. Não foi implementada/validada entrega física de push financeiro;
registro administrativo não equivale a push entregue.

## 15. Histórico

Cada coleta preserva snapshot append-only. `finops_monthly_history` seleciona a
última observação de cada mês, no escopo solicitado, sem modificar anteriores.
Períodos de 1/3/6/12 meses e todos são filtros de observações existentes; meses
anteriores sem captura não são fabricados ou reconstruídos a partir de dados atuais.

## 16. Validação comprovada antes de publicação

Checkpoint consolidado confirmado pelo agente principal: **54 testes unitários/API
PASS**, cobrindo capital, modelo/autorização, providers, rota e guardas de sync.
Typecheck, lint e build de integração passaram. Validação consolidada do código
publicado em `357a6330defa79d69a1bf75057702c37fd6a9d17`: 54 testes direcionados
(6 API, 15 capital, 7 FX repair, 16 modelo e 10 providers) e 8 SQL, total 62 PASS.

**8 testes SQL PASS** em PostgreSQL 17 descartável, somente `127.0.0.1`:

1. seed limitado aos planos comprovados; futuro executor sem preço herdado;
2. RLS/grants negam visitante/VIEWER, inclusive com default privileges amplos;
3. guards negam serviço cross-tenant, revisão cross-operator e troca de ownership;
4. snapshots/revisões imutáveis, histórico e FX preservados;
5. duas claims simultâneas admitem exatamente um worker, outro operador independente;
6. lease expirado não publica; sucessor publica atomicamente; snapshot manual não muda cooldown externo;
7. custos nulos, moedas, créditos e restrições de período persistem corretamente;
8. fixture independente de trading permanece intacta.

Harness: `apps/web/lib/coinops-finops/migration-sql.integration.ts`. Não carrega `.env`,
URL Supabase ou credenciais reais. Descobre apenas a migration FinOps pelo sufixo,
cria banco efêmero e encerra o processo no final. No Windows, `pg_ctl` pode exigir
execução fora do sandbox por criação de restricted token; isso não autoriza banco remoto.

Comandos, a partir de `apps/web`:

```powershell
node --experimental-strip-types --test lib/coinops-finops/*.test.ts app/api/coinops-finops/route.test.ts
node --experimental-strip-types --test lib/coinops-finops/migration-sql.integration.ts
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
```

O harness SQL não integra o glob de unitários. Requer PostgreSQL local;
`COINOPS_AUDIT_PG_BIN` pode indicar o diretório de binários. Resultado SKIP por
PostgreSQL ausente não satisfaz a prova SQL. Não apontar testes ao Supabase vinculado.

## 17. Rollback aditivo

Rollback de aplicação: restaurar release/SHA anterior pelo fluxo Git/Vercel oficial,
remover/desabilitar apenas o cron FinOps se o incidente for desta função e preservar
o restante do monitoramento/trading. Não reiniciar executores por problema de FinOps.

Migration é aditiva. Não executar DROP/TRUNCATE nem apagar snapshots/revisões para
reverter UI. Manter tabelas/grants isolados e sem consumidores é rollback seguro.
Correção estrutural futura deve usar nova migration versionada, sem reescrever a
aplicada. Mudança de critério de rateio cria nova revisão/snapshot; não edita histórico.

## 18. Gates finais e alcance da evidência

| Gate | Resultado | Evidência |
| --- | --- | --- |
| FINOPS_ADMIN_ACTIVE | PASS — COMPROVADO | Menu ADMIN, rota e sync autenticados no domínio Production |
| CAPITAL_MONITORED_ACCURATE | PASS no escopo definido — COMPROVADO | Seis contas com cobertura nativa completa, fontes canônicas e conversão explícita; testes sem dupla contagem |
| MULTI_SHARD_COST_ACTIVE | PASS — COMPROVADO | Dois shards do registry e quatro serviços no snapshot/UI |
| BILLING_SYNC_ACTIVE | PARCIAL | Coleta FinOps server-side e cron autenticado COMPROVADOS; integração automática de faturas NÃO ATIVA, providers compartilhados MANUAL |
| FX_SNAPSHOT_ACTIVE | PASS — COMPROVADO | USD e USDT com fontes/horários distintos no snapshot imutável |
| MONTHLY_HISTORY_ACTIVE | PASS — COMPROVADO | Setembro persistido e exibido; imutabilidade e seleção mensal testadas; sem histórico fabricado |
| COST_PROJECTION_ACTIVE | PASS — COMPROVADO | R$163,63/US$31,48 projetados, com classificação e método explícitos |
| CAPACITY_COST_INTEGRATION_ACTIVE | PASS — COMPROVADO | Métricas por shard, SCALE_OUT e custo de referência; admissão/trading não alterados |
| VIEWER_COST_ISOLATION_PASS | PASS técnico — COMPROVADO | Guards de API/modelo, 8 provas SQL, RLS/grants remotos e visitante 401; login VIEWER real NÃO TESTADO |
| TRADING_UNAFFECTED_PASS | PASS no intervalo observado — COMPROVADO | Nove engines ACTIVE antes/depois, kills falsos, reconciliação recente, 11 TPs e nove BUYs residentes no ledger |

Não afirmar billing de faturas automático, push físico entregue, execução natural
futura do cron ou login de VIEWER como comprovados. Esses limites não impedem a
operação do menu com estimativas explicitamente identificadas.

## 19. Publicação, sincronização e smoke

- Produto CoinOps, Supabase `otdfpmsegjxpqrzisfmi`, schema `coinops`, Production;
  escopo do ADMIN proprietário validado server-side, sem tenant vindo do browser.
- Migration aplicada e alinhada local/remoto:
  `20260927005603_add_coinops_finops_admin.sql`.
- Cinco tabelas com RLS + FORCE RLS; `anon` e `authenticated` sem SELECT.
  Snapshots e revisões append-only, grants mínimos e RPCs invoker com fencing.
- Código: `407cbf9` (módulo) e
  `357a6330defa79d69a1bf75057702c37fd6a9d17` (FX e cron), enviados sem force push
  de `codex/coinops-executor-02` para GitHub/main.
- Vercel Production **READY**: `dpl_ET7PtTN82rpBVhytKi8nFtSraVVT`, SHA `357a633`,
  alias `https://cripto-flax.vercel.app`. Deploy por integração GitHub.
- Coleta externa inicial: `2026-09-27T01:04:56.610Z`. Quatro serviços, seis
  contas, nove motores, dois executores. USD presente; USDT inicialmente ausente.
- Causa corrigida: snapshot com FX parcial podia informar OK; reparo usa o host
  público oficial `data-api.binance.vision`, reconhece falta de câmbio e permite
  somente revalorização limitada durante cooldown. O motivo HTTP exato da falha
  inicial não foi capturado e não é atribuído por suposição a geobloqueio.
- Novo snapshot imutável `FX_REPAIR` às `2026-09-27T01:20:38.557Z`, status **OK**,
  `capitalComplete=true`. Capital/infra continuam com timestamp original.
  `last_external_synced_at` permaneceu 01:04:56.610Z: não houve segunda coleta
  privada, billing ou Binance account para corrigir o câmbio.
- USD/BRL **5,1991**, BCB PTAX venda, observado `2026-09-25T16:10:17.447Z`.
  USDT/BRL **5,1965**, Binance Spot, observado `2026-09-27T01:20:37.807Z`.
  O snapshot anterior permaneceu intacto.
- Cron FinOps registrado e Enabled na Vercel, `17 */6 * * *`. Executado uma vez
  pelo botão **Run** do job exato: GET `/api/cron/coinops-finops` **200** às
  01:21:34 UTC. A janela já coletada não foi repetida. Disparo natural às 06:17
  ainda não observado; não confundir esse smoke autenticado com execução futura.
- POST ADMIN `/api/coinops-finops` **200** às 01:20:38. Endpoints API e cron sem
  autenticação retornaram **401**. Logs Vercel dirigidos não mostraram falha FinOps.
- Menu → `/custos-operacao` validado autenticado em desktop e nas larguras
  320/360/375/390/430/768 px, sem overflow horizontal. Capturas desktop/mobile
  exibidas na sessão de validação. Não foi simulada uma conta VIEWER real.
- Console do Chrome registrou `Could not establish connection. Receiving end
  does not exist.` durante navegação; não há stack suficiente para atribuir sua
  origem. Não declarar console totalmente limpo. API, UI e sync funcionaram.
- Leitura LIVE final às 01:21 UTC: seis contas, nove engines/runs ACTIVE,
  kill switches falsos, reconciliação dos nove entre 01:20:15 e 01:20:27.
  Leitura adicional: 225 slots, 11 posições abertas, 11 SELL/TP NEW e nove
  BUY/ENTRY NEW. É evidência do ledger/reconciliação normal, não nova consulta
  pesada independente da exchange. Nenhuma ordem criada/cancelada por FinOps.

## 20. Valores financeiros publicados

Valores na cotação acima, fontes observadas em 26/09–27/09/2026. USD com mais
casas é mostrado abaixo para explicar o rateio; UI usa duas casas e soma valores
arredondados por serviço. BRL é indicativo, não câmbio efetivo de cartão/banco.

| Componente CoinOps | USD/mês | BRL/mês | Evidência financeira |
| --- | ---: | ---: | --- |
| Executor 01 | 6,00 | 31,19 | ESTIMADO — tarifa documentada |
| Executor 02 | 6,00 | 31,19 | ESTIMADO — tarifa documentada |
| DigitalOcean total | 12,00 | 62,38 | ESTIMADO |
| Supabase CoinOps | 12,328505 | 64,10 | RATEIO_ESTIMADO, entrada MANUAL |
| Vercel CoinOps | 7,14625 | 37,15 | RATEIO_ESTIMADO, entrada MANUAL |
| Total rateado | 19,474755 | 101,25 | RATEIO_ESTIMADO |
| **Total operacional mensal** | **31,48** | **163,63** | **ESTIMADO + RATEIO_ESTIMADO** |
| Total REAL diretamente atribuível | Indisponível | Indisponível | Sem cobrança CoinOps comprovada; não declarar zero real |

- Projeção do mês: **R$163,63**, não valor cobrado.
- Custo médio por conta: **R$27,27** (seis contas).
- Custo médio por motor: **R$18,18** (nove motores).
- Infraestrutura direta por executor: **R$31,19**. Não confundir com média
  contábil de todos os serviços divididos por dois: **R$81,82**.
- Incremento de referência para VPS equivalente: **+US$6 / +R$31,19**, sem
  provisionamento, não garantia de capacidade para um número fixo de contas.
- Capital monitorado: **R$2.338,59 + 838,62 USDT**, consolidado **R$6.696,48**.
  Patrimônio dos usuários, separado de custo e de resultado da estratégia.
- Supabase: base organização **US$35** equivalente mensal (Pro 25 + dois Micro
  20 − crédito 10); metade Platform, depois participação de bytes CoinOps,
  resultando em 35,2243% da base. Proxy técnico, não medição de consumo total.
- Vercel: base **US$20**, oito projetos, rateio 12,5%. Consumo on-demand observado
  **US$16,15**, após crédito, no ciclo 14/09–14/10. Run-rate no período leva a
  **US$57,17** projetados no time e US$7,14625 atribuídos por rateio ao CoinOps.
  Invoice atual estimada do time US$36,15 não é invoice exclusiva CoinOps.
- Não encontrados serviços pagos adicionais atribuíveis com base suficiente.
  Não incluir Resend, Mercado Pago ou custos hipotéticos. Ausência de extras
  comprovados não significa garantia de custo zero para qualquer extra futuro.

## 21. Limitações e próxima ação

O menu está operacional com estimativas úteis, registro histórico e sync server-side.
Custos compartilhados dependem de configuração administrativa revisável. Tokens
opcionais de inventário/billing não foram criados ou copiados; não há integração
automática de invoice ativa. Habilitá-los futuramente exige acesso mínimo de leitura
e atribuição segura por recurso/projeto, sem dupla contagem com o rateio atual.

Cenários +10/+50/+100 contas permanecem condicionais à capacidade comprovada,
sem tarifa fictícia por quantidade de usuários. Não há meses anteriores inventados.
Push financeiro físico não foi validado. A primeira execução natural futura do
cron ainda deve ser observada; o caminho autenticado já respondeu 200 no smoke.

Usar o menu e manter os valores MANUAL atualizados quando planos/consumo mudarem.
O monitor operacional de duas horas é independente e não deve recolher billing
ou executar benchmarks por rotina.
