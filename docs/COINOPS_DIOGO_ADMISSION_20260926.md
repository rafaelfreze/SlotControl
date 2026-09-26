# Diogo / SOLBRL — diagnóstico de admissão (26/09/2026)

Escopo: exatamente um novo motor REAL, R$275, 25 slots. Fonte publicada:
GitHub/main `b97e396e4c74581cdfdd00a1cf6d297b668304fe`, Supabase
`otdfpmsegjxpqrzisfmi` / `coinops`, Executor 01 `46.101.104.48`.
Este registro é um checkpoint datado, não uma autorização permanente.
O estado inicial acima é histórico; a publicação e a reatribuição posteriores
estão registradas na seção final, sem substituir as medições originais.

## Por que 3018/6000 apareceu junto de 85,7%

COMPROVADO: a UI publicada mostra o contador mais recente (`3018`) mas usa
o percentual de `max(atual, média, pico15min)` calculado pelo Capacity Manager.
O pico era `5139`; `5139/6000 = 85,65%`, exibido como `85,7%`.
`3018/6000 = 50,3%`. É uma ambiguidade de apresentação, não divisão errada
ou projeção secreta de vários motores. A média é a média dos máximos de
cada minuto observado da janela, não média de todos os requests.

Correção de apresentação preparada na branch multi-shard: separar consumo
atual/percentual atual de pressão conservadora, média e pico. Não altera a
política nem autoriza ativação. Publicação precisa ser confirmada separadamente.

## Medição passiva

Somente leitura das amostras que o cron já persistia; nenhum benchmark,
READ_STATE, snapshot administrativo ou request Binance foi disparado para
esta medição. A aba de smoke aberta pelo agente foi fechada. Processos do
VPS não mostraram harness/benchmark ativo; serviço permaneceu no mesmo PID,
sem restart. Não é possível excluir leituras legítimas do usuário no painel.

| Amostra UTC | Atual | Média janela | Pico janela | CPU processo | RSS MB | Fila | Idade máxima reconciliação |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 19:57:41 | 2257 | 3082,47 | 5139 | 2,000% | 176,68 | 0 | 26,3 s |
| 19:58:42 | 2257 | 3082,47 | 5139 | 2,152% | 176,68 | 0 | 26,5 s |
| 19:59:42 | 2571 | 3102,00 | 5139 | 2,978% | 176,80 | 0 | 25,8 s |
| 20:00:41 | 2257 | 3049,19 | 5139 | 3,234% | 176,80 | 0 | 25,4 s |

Heartbeat/amostras recentes, registry confere 4 contas/7 motores,
erros/retries 0 nos cinco minutos. A janela móvel pode tocar 16 minutos
calendário parcialmente, sem exceder 15 minutos de duração.

COMPROVADO às 19:59:02 UTC no ledger já reconciliado pelo executor:
Rafael BTCBRL/SOLBRL, Thyely BTCUSDT/SOLUSDT, Caixeta BTCBRL/SOLBRL e
Pedro SOLBRL ACTIVE; runs ACTIVE; kill switches locais false; 25 slots
por motor; 9 posições com 9 TPs e 7 ENTRY residentes; zero alertas abertos
de trading; last_error null. Não foi feita consulta independente adicional
à exchange para não contaminar o consumo. Diogo INACTIVE/PREPARING, 25 slots,
zero posições e zero ordens, cap R$275.

## Incremento e decisão neste checkpoint

COMPROVADO: configuração efetiva no banco: limite 6000, admission_ratio 0,65,
incremental_engine_weight 900. Reservas pendentes: zero.

`max(atual, média, pico15min) + reservas + 1 × 900 = 5139 + 0 + 900 = 6039`.

Teto de admissão: `6000 × 65% = 3900`; reserva de recovery: `2100` (35%).
Projeção conservadora excede o teto em `2139` e o limite total em `39`.
Decisão: `DIOGO_SOLBRL_ADMISSION_BLOCKED`; ação se a margem continuar ausente:
`EXECUTOR_02`. Nenhum override, threshold, estratégia, ordem ou estado LIVE
foi alterado. O gate normal deve recalcular no momento do próximo Preview/Activate.

900 é estimativa conservadora, não marginal p95 comprovado para SOLBRL.
Não há evidência para reduzi-lo. R$275/25 slots não significa 25 vezes o
custo de um motor nem garante baixo custo de API. Sem outras reservas, uma
nova admissão de um motor só atende o critério numérico quando a pressão-base
está no máximo em 3000; todos os demais guardas também precisam passar.

INFERIDO, não atribuição comprovada: onboarding e leituras de UI podem ter
contribuído ao pico. CONNECT/Preview/Provision/Activate fazem verificações
de leitura; a ausência de benchmark agora não permite apagar o pico da
janela anterior ou atribuí-lo exclusivamente à auditoria.

## Regressão

`capacity-manager.test.ts`: cenário 3018/5139 reproduz 50,3% versus85,65%,
bloqueia +900, permite limite-base3000+900, bloqueia3001+900 e distingue
um motor de dois. Cinco testes passaram; typecheck passou. Sem chamada
financeira, reserva SQL ou clique Activate durante o diagnóstico.

## Atualização — whitelist do Executor 02 confirmada pelo proprietário

O proprietário confirmou que a API do Diogo já está restrita ao IP
`164.90.223.159` (Executor 02). Portanto, não tentar ativar Diogo pelo
Executor 01, mesmo que sua janela de capacidade melhore. O vínculo antigo
do cadastro ainda era executor-01; whitelist e vínculo são verificações
independentes. A transição será explícita, somente para esta conta nunca
operada, mantendo INACTIVE/PREPARING, sem copiar credencial entre vaults.
Nova validação de credencial pelo Executor 02 é obrigatória antes de Preview
e da ativação pelo próprio usuário.

A coleta passiva seguiu sem benchmark: às 20:08:42 UTC a pressão caiu para
2889 (média2384,47, atual2889), cuja projeção com um motor era3789/6000
(63,15%, reserva36,85%). Isso não autorizou ativação nem troca de IP.
Às 20:17:42 UTC, com uso normal do produto, o pico registrado voltou a5357,
atual3241/média3272,4, CPU4,767%, RSS178,05MB, fila0, sete motores e quatro
contas conferindo. A capacidade não é um limite fixo de usuários e precisa
ser recalculada na admissão. Não apagar picos para conseguir PASS.

Às20:18:30 UTC, os sete runs atuais continuavam ACTIVE, kill switches false,
reconciliações20:18:15–20:18:27 e last_error null. Runs COMPLETED anteriores
foram preservados e não devem ser confundidos com o estado do ciclo atual.

## Checkpoint de reatribuição — 2026-09-26T20:57:55Z

**COMPROVADO:** GitHub/main `fd567fe613108c0c7e2ae7bed57cd02ed7ff7d30`
publicado na Vercel, deployment `dpl_6fNfjUvMk87HaExZFKg4bybzJvMM` **READY**.
Executor02 no mesmo SHA `fd567fe`, health **HEALTHY**, IP `164.90.223.159`.

**COMPROVADO:** Diogo foi reatribuído pelo fluxo normal autenticado da UI ao
Executor02 às20:57:55UTC, preservando conta **INACTIVE**, zero ordens, capital
R$275 e 25 slots. A mudança de executor não ativou o motor e não autorizou
compra manual. O vínculo antigo01 deixou de ser o destino do onboarding.

**COMPROVADO:** bootstrap server-side registrou as quatro identidades das
contas LIVE existentes. A configuração temporária
`COINOPS_INITIAL_IDENTITY_BINDINGS_JSON` foi removida da Vercel; sua retirada
do runtime ocorrerá no próximo deploy. Nenhum valor de hash ou secret é
registrado neste documento. Os sete motores do Executor01 permaneceram
intactos, PID94831 sem restart.

**COMPROVADO na UI autenticada às2026-09-26T21:01:32.184Z:** credencial de
Diogo **PASS / REAL**, executor `164.90.223.159`, whitelist aceita, leitura
e Spot habilitados; saques e transferências interna/universal desabilitados.
Conta atribuída ao Executor02; SOLBRL **INACTIVE**, R$275, 25 slots, R$11/slot.
Nenhum UID, fingerprint ou hash foi incluído neste documento.

**A CONFIRMAR:** Preview e Capacity Check final. **Ativação não executada**;
ela permanece no fluxo normal, a ser confirmada pelo próprio usuário.

**NÃO TESTADO nesta etapa:** Testnet E2E no Executor02, entrega física de push
multi-shard e monitoramento do Executor02 offline. Health e publicação não
transformam esses gates em PASS, nem autorizam declarar todos os gates READY.
