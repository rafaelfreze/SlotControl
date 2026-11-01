# Entrada MARKET do dono prioritário de nível atravessado

Autorização do proprietário em 01/11/2026: entrar pelo preço de mercado quando
o nível da próxima entrada prioritária foi atravessado sem execução. Produto
CoinOps, projeto `otdfpmsegjxpqrzisfmi`, schema `coinops`, REAL. Esta decisão
complementa MONTHLY_GAINS_V1; não modifica gain, meta, spacing ou capital.

## Contrato e decisão

`PRIORITY_MISSED_MARKET_V1` tem versão própria. O protocolo histórico 4.3.1 e
ordens LIMIT antigas continuam reconciliáveis. Entre slots do conjunto permitido,
mantém-se mês America/Campo_Grande, gains mensais DESC, lifetime DESC, físico ASC,
meta individual e exceção N/N, PRIMARY/RESERVE e reentrada local canônicos.

O slot prioritário vazio cujo nível já foi atravessado pode receber uma MARKET
com seu saldo completo, inclusive ganhos reinvestidos. Filtros e precisão Binance
determinam a quantidade executada e resíduos; o valor solicitado não é reduzido
para o mínimo nocional. Uma chamada não compra uma sequência de níveis. Níveis
prospectivos inferiores continuam na fila até sua vez. Posição OPEN, execução
parcial, intenção incerta ou evidência incompleta nunca equivalem a entrada perdida.

MISSED anterior à publicação permanece histórico. A recuperação excepcional
exige ação `REENTER_MISSED_MARKET`, com conta, engine, asset, run, slot e sequência
exatos, evento MISSED_LEVEL de ausência de BUY residente e posição/execução zero.
O caso autorizado nesta manutenção é Rafael/BTCBRL físico #7, operação 8; outros
MISSED antigos não são varridos. O endpoint oficial usa credencial de controle
dedicada, resolve valores server-side e não aceita preço ou valor do caller.

### Recuperação explícita de operação após a virada

Esclarecimento posterior em 01/11: o operador pediu que Rafael #7 fosse efetivamente
recolocado na operação, sem continuar aguardando o #9 (1/7 no mês contra 0/7 do #7,
que possui 7 ganhos históricos). A autorização anterior somente liberava sua
elegibilidade; a ordenação mensal mantinha o #9 na frente. Não havia fill do #7.

`EXPLICIT_OPERATION_V1` restringe o conjunto permitido de uma decisão de recuperação
à operação MISSED expressamente identificada. A mesma Strategy Engine calcula a
entrada, mantendo os contadores reais, a meta do próprio slot e os gates de
regime/residente/partial-fill. Depois do fill, a fila mensal normal volta a valer.
Não é uma mudança global de prioridade para lifetime nem uma varredura de MISSED.

A nova ação administrativa registra evento com sufixo próprio, sem sobrescrever
o pedido antigo, e snapshot escopado ao engine/run/slot/sequência/mês/orçamento.
A preparação SQL continua exigindo igualdade exata com esse evento imutável.
Autorizações antigas sem marcador não ganham prioridade excepcional. Uma operação
OPEN/partial, mês/operação diferentes ou autorização sem prova nunca qualifica.
BUY residente atravessada ou com fill prevalece; apenas NEW/zero-fill comprovada
pode ser cancelada via ONLY_NEW. O TP da nova operação usa o fill real e as ordens
anteriores permanecem intactas. O ajuste é web-only, sem migration ou mudança no
grafo nativo: verificar fingerprint, sem restart dos executores.

## Protocolo financeiro

1. Claim/lease do engine, configuração sem atualização pendente, ledger completo,
   reconciliação e TPs de todos os OPEN comprovados. Verificar intenção/dispatch
   pendentes, saldo Spot, BNB, caps da conta/engine e filtros.
2. Calcular decisão canônica única. Um BUY residente parcial ou atravessado tem
   prioridade de reconciliação. Outro BUY NEW/zero-fill só pode sair com ownership
   exato, ONLY_NEW e leitura terminal com execução zero. Fill concorrente vence;
   timeout ou ausência exige readback, nunca recriação presumida.
3. Registrar intenção, snapshot imutável escopado e decisão OPEN_ENTRY_MARKET.
   RPC sob lease valida elegibilidade/meta/saldo inteiro/caps/ausência de BUY e
   prepara ENTRY+quote com quantidade/preço NULL, armando atomicamente o slot.
4. Executor com `entry_market_protocol=1` usa journal/query-first e clientOrderId
   determinístico, verifica novamente gates/cash/BNB/caps e nenhuma BUY própria
   residente. Preservar STP EXPIRE_TAKER e reservas por conta/IP.
5. Reconciliar fills reais e comissão. Somente a nova operação pode fixar sua
   referência pelo preço médio real, arredondado ao tick, com evento imutável.
   Criar TP pela quantidade efetiva e gain já configurado; depois planejar uma
   NEXT BUY normal conforme a estratégia. Erro financeiro fica no engine afetado.

Resposta MARKET perdida não autoriza outro POST: consultar a mesma ordem/intent.
Crash depois do prepare retoma o mesmo clientOrderId. Migração não envia ordens,
não move saldo e não reescreve snapshots antigos. RPC de referência é
SECURITY INVOKER; ambos os RPCs financeiros são somente service_role. RLS e
guards de identidade existentes continuam aplicáveis.

## Publicação e validação

Migration `20261101123000_live_priority_market_entry.sql`, exclusivamente CoinOps.
Aplicar após validar versão remota e testes em PostgreSQL descartável. Mudança de
transporte requer release comum e rollout sequencial, paridade e recertificação
de admissão; nenhum engine novo ou recurso pago é necessário.

Testes isolados cobrem saldo integral/ganhos, metas/virada mensal/N/N,
25/50/100 slots sem certificar capacidade, regime PRIMARY/RESERVE, ownership,
LIMIT residente, fill/cancel concorrente, HTTP 503, resposta perdida,
idempotência, referência/TP reais e permissões SQL. Testes não fazem trades LIVE.

## Limite unitário legado e saldo reinvestido

A tentativa real do Rafael #7 expôs um segundo guard legítimo: seu limite por
ordem ainda era R$18,00 na preparação e no executor, enquanto o slot detinha
R$19,26268762 (R$18 + R$1,44432 de PnL - R$0,18163238 de taxas). O worker retornou
CAPACITY_HOLD antes de cancelar a NEXT BUY. Capital total de motor R$450 e conta
R$775 já comportavam a exposição; nenhum desses limites precisa crescer.

Somente a recuperação explícita, vazia e comprovada pode alinhar o teto unitário
ao saldo autorizado. O backend mantém inventário completo da conta/moeda e envia
`ORDER_CAP_ALIGNMENT_V1` ao admin/capital: todos os hard caps permanecem iguais,
exatamente um limite unitário aumenta por CAS e os irmãos conservam seus valores.
O protocolo nativo é anunciado em health. Não editar registry/vault manualmente.

Após readback nativo sem alteração de ordens, a RPC
`align_live_recovery_order_cap` valida lease, identidade, autorização imutável,
operação MISSED vazia, compounding e saldo formado por contribuição + PnL - taxas.
Somente metadados da preparação e `engine.config.max_order_quote` são alinhados
atomicamente, com evento RECOVERY_ORDER_CAP_ALIGNED. Não cria ganhos, saldo,
aporte, ordem nem altera gain/meta/spacing. Falha ou crash mantém a operação
fechada até os dois lados concordarem; resposta perdida exige readback.

Migration: `20261101171116_live_recovery_order_cap_alignment.sql`. SECURITY INVOKER,
EXECUTE apenas service_role. O transporte financeiro conserva seus hard caps e
novo preflight verifica também o teto nativo antes de qualquer cancelamento.
Esta continuação altera o admin runtime: requer release comum/rollout sequencial,
versões web exatas em janela UTC limitada, paridade e certificação de admissão.
Os testes cobrem replay, perdas de resposta, cap/lease/saldo divergentes,
permissões, preservação dos irmãos e veto sem protocolo ou ganho comprovado.

O alinhamento usa o roteamento imutável do engine já instalado, não o gate de
onboarding de uma nova conexão. Rafael conserva a credencial legacy no Executor
01; status histórico VALIDATION_REQUIRED do cadastro não pode impedir esse
controle autenticado de metadados. O registro nativo ainda valida a credencial,
conta, shard e inventário completo. Os testes simulam onboarding indisponível
nos casos legacy e dinâmico; nenhum gate de cadastro novo foi relaxado.

O schema real mantém `max_order_notional_quote` como coluna gerada de
`max_order_notional_brl`. A migration corretiva
`20261101175214_fix_recovery_order_cap_generated_alias.sql` atualiza somente a
coluna canônica. O fixture SQL reproduz a coluna gerada, para que uma tentativa
de gravar diretamente no alias falhe também antes da publicação.

## Limitação distinta: parcial da Dete

Dete/SOLBRL #8 operação 3 foi uma BUY original de 2,187 SOL a R$513,10
(R$1.122,1497), financiada por saldo próprio de R$1.122,26938511. Apenas 0,004 SOL
executou (R$2,0524 antes da comissão). O restante foi cancelado pelo reconciliador
antigo e a fração não atinge o mínimo de R$10 para TP. Isso não foi uma compra
intencional de R$2 ou R$10. A correção anterior impede novo cancelamento desse
tipo; a posição já parcial continua BLOCKED_SAFE, preservando sete TPs prévios.
O protocolo atual de TP aceita uma BUY de origem. Complementar essa posição exige
protocolo próprio de agregação validado, sem aplicar a nova regra de slot vazio.
Nenhuma compra complementar foi enviada nesta manutenção.
