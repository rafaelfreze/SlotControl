# Thyely SOLBRL50 — configuração autorizada e bloqueio de admissão

16/10/2026. Produto CoinOps; OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema
`coinops`, Production. Evidência de leitura/testes, não certificado de capacidade.

## Decisão e configuração

**BLOCKED — nenhum novo motor criado ou ativado.** A alteração autorizada é
um motor independente no Executor03: **50 slots × R$22 = R$1100**, gain3%,
meta3gains/slot/mês, spacing normal2% e pós-ATH3%. O pedido anterior de100slots
foi substituído; não há autorização para alterar os dois motores USDT existentes.

O formulário autenticado foi preenchido com essa configuração, sem provisionar
motor ou enviar ordem. O gate oficial impede APPEND enquanto o perfil exato50
não estiver comprovado. Uma configuração de formulário não é DRAFT persistido.

## Financeiro e Binance — leitura real, não reserva

GET somente leitura pelo Executor03 às **18:38:04.631Z**:

- BRL livre **1100,2577625**, bloqueado0; BNB livre **0,00663968**.
- SOLBRL `TRADING`; mínimo nocionalR$10, lote mínimo/step0,001SOL,
  tickR$0,10, máximo200ordens por símbolo. Zero ordens residentesSOLBRL.
- Sizing canônico: **50/50 executáveis** tanto NORMAL quanto POST_ATH.
  Mínimo de capital estimado531,83/529,43; recomendado10,88/10,83 por slot,
  respectivamente. Isso não garante execução futura em todo preço/cenário.
- Comissão maker/taker0,1%; descontoBNB habilitado por conta/símbolo. GuardBNB
  atual aprovado não é estimativa nem garantia de todas as taxas futuras.
- Motores antigosUSDT têm13ordens residentes (5BTCUSDT/8SOLUSDT), consideradas
  na avaliação account-global. Nenhuma delas foi cancelada/recriada.

SQL somente leitura às **18:49:05.003176Z** confirma ausência de capBRL e de
engineSOLBRL nessa conta. Há somente BTCUSDT25 e SOLUSDT25, ambosACTIVE/01.
Assim o caixaBRL não foi confundido com capitalUSDT. Esses snapshots não foram
usados para ativação: o fluxo oficial teria de refazê-los e reservar atomicamente.

## Gate oficial e motivo técnico

Na mesma consulta às18:49:05Z, telemetria do03 às18:48:42Z:

| Consulta canônica | Resultado |
| --- | --- |
| `preview_engine_slot_admission('executor-03','REAL',array[50])` | `CAPACITY_UNKNOWN / SLOT_WORKLOAD_UNCERTIFIED` |
| Três unidades conservadoras, incremento2700 | `CAPACITY_OK`, projeção3471,67/3900 |
| Quatro unidades conservadoras, incremento3600 | `CAPACITY_REQUIRED`, projeção4371,67/3900 |

Peso sustentado medido771,67; peso corrente774; reservas0; Executor03HEALTHY.
São projeções da política `capacity-v3-20260930`, não medições do novo motor.
CPU/RAM baixos não comprovam headroom de Binance nem perfil para50slots.

Teste dirigido reproduziu uma cadeia de componentes ACTIVE com **2816peso
REST**,15primeiras leituras503 seguidas de sucesso, budget na primeira tentativa
e três POSTs exclusivamente em memória. É maior que2700, antes dos retries
externos e demais caminhos ainda não limitados. Não é consumo real deProduction
por minuto nem execução integral de `advanceLiveRun`. Logo não há prova para
assinar três unidades; tampouco há upper bound que certifique quatro.

Ver `coinops-fifty-workload-evidence-20261016.md` para hipóteses, trace, fontes
de pesos, limites e alternativas. Nenhum perfilPASS foi fabricado ou gravado.
Não foi mudada política, reserva de recovery, frequência ou proteção para caber.

## Testes e recursos

- Harness50×22: fills simultâneos/parciais, crash após fill/gain17,503,
  idempotência, lease/CAS, ownership e isolamento entre motores/shards.
- Continuidade:50gains, sucessor único com50slots, primeira BUY/TP/NEXT e
  replay sem efeitos financeiros duplicados, em banco descartável.
- Probe do transporte real no hardware03:50+25+25slots sintéticos, até4workers
  no alvo e1em cada irmão, fila canônica por shard. Sandbox `nobody`, sem rede,
  cofre, ambiente ou estadoLIVE; CPU10%, memória128MiB, limite30s.
- Recursos do probe:3,503s, CPU354,419ms, picoRSS112332800bytes;627requests
  simuladas, peso2062(1990privado+72público),100TPobservadas, zeroPOST/DELETE.
  Isso mede transporte/fila isolados, não cronVercel/Supabase completos.

Os resultados detalhados estão nos artefatos de testes50 e no inventário de
workload. A quantidade50 foi testada diretamente, sem extrapolar `N/25`.

Validação conjunta final: **37/37 PASS**, incluindo preflight somente leitura,
probe, reconciliação50/100 e continuidade50/100; **9/9 PASS** adicionais da
ferramenta de certificação. Total46, zero falhas/skip. Sintaxe Node e
`git diff --check` aprovados; somente avisos de EOL Windows e módulo TypeScript
já existentes. Não houve build/lint/typecheck da aplicação nesta etapa porque
nenhum código/configuração compilável da aplicação foi alterado.

A nova ferramenta `tools/operations/certify-slot-workload.mjs` usa VERIFY por
padrão e só permite RECORD explícito com artefato integral revisado, fonte main
atual, fleet fresca e CAS/transação/RPC oficial. Preserva evidências/perfis dos
outros executores. Seus testes usam somente fixtures e PostgreSQL descartável;
ela **não foi executada contra Production**, e nenhum certificado real existe.
O SQL vigente não invalida perfil automaticamente por mudança posterior no web;
mudança relevante exige nova prova/recertificação. Essa limitação é explícita,
não um gate supostamente resolvido pelo helper.

## Preservação Production

SQL das18:49:05Z: **16runsACTIVE/PAUSED**, todos25slots,400slots existentes,
zero `last_error`, zero fill executado pendente; reconciliação mais antiga
18:48:18.538Z. Watchdog às18:48:46.406Z:01HEALTHY7,02HEALTHY7,03HEALTHY2;
zero BLOCKED, RECOVERING ou STALE, zero incidente crítico aberto.

Código-base analisado: `f82e134084c67b424809c586a3b7b4cd46e00489`.
Runtime comum permanece `7f93dc8a687edb6b4bd509f3ccdf5aafa56f860a`, Node24.21.0.
As alterações desta etapa são ferramentas, testes e evidências; nenhuma migration,
mudança de runtime, reinício de executor ou alteração financeira foi realizada.

## Próximo gate indispensável

Instrumentar o fluxo ACTIVE completo e provar limite por minuto com agenda,
retries e proteção, eliminando somente leituras redundantes comprovadas.
Depois, certificar o perfil exato50 e consultar admissão novamente. Se aprovado,
refazer saldo/reservas/filtros e seguir APPEND/PREPARE/ACTIVATE oficial com nova
identidade e idempotência. Esta evidência não autoriza contornar esse gate.

**50SLOTS LIVE: NÃO CRIADO/NÃO ATIVADO. MOTORES ANTERIORES PRESERVADOS.**
