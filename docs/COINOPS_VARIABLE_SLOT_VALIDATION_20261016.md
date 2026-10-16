# CoinOps — topologia variável e proposta Thyely SOLBRL

## Escopo

Produto CoinOps, repositório SlotControl/main, backend OnPlay Platform
`otdfpmsegjxpqrzisfmi`, schema `coinops`. Configuração solicitada: novo engine
independente no Executor 03, SOLBRL, 100 slots de R$11 (R$1.100), gain 3%,
meta 3/slot/mês, normal 1% e pós-ATH 2%. Nenhuma modificação de estratégia,
capital ou ordens dos engines existentes está incluída.

## Diagnóstico e implementação

O limite 25 estava distribuído em constraints, RPCs, preparação, contadores,
provas de ledger, pós-ATH, namespaces e consumidores administrativos. A coluna
imutável `trading_engines.slot_count` é a autoridade, com default retrocompatível
25 e validação de software 2..100. Run e preparação devem concordar; quantidade
de linhas retornadas nunca substitui a configuração. O cadastro aceita capital
por slot, valida centavos/soma e invalida preview após edição. Não redimensiona
engine existente. Relatórios novos usam contrato 25, sem reescrever histórico.

Para N elegíveis, mantêm-se até 15 PRIMARY conforme a prioridade canônica e
N−15 RESERVE na ordem vigente. Assim, 100 elegíveis produzem até 15/85, não
60/40 e não os primeiros 15 números físicos. Identidade/rank físico, ganhos,
metas individuais, reinvestimento e aportes são preservados. Quantidade N não
autoriza N BUY: continua no máximo uma NEXT BUY residente por engine. O orçamento
de ordens compartilhado reserva N+1, por conta/par, em todos os shards.

Referência monetária de preparação é normalizada em oito casas, como o banco,
sem alterar os capitais reais em centavos. O seed inicial usa um único RPC
transacional/idempotente com prova de ledger íntegro, evitando N UPDATEs.

## Evidência de mercado e saldo — leituras, não ativação

Em 16/10/2026, 16:24Z, filtros públicos SOLBRL: mínimo nocional R$10,
stepSize 0,001 SOL, tickSize R$0,10 e máximo de 200 ordens por símbolo. Snapshot
ask R$531,30/bid R$530,60. O sizing canônico com reserva conservadora de fee
0,2% aprovou 100/100 nos regimes normal e pós-ATH. Mínimos estimados de capital:
R$1.071,63 e R$1.071,42, respectivamente. Isso não comprova execução futura em
qualquer preço, taxa efetiva da conta, liquidez, latência ou partial fills.

Leitura autenticada da Thyely no Executor 01 às 16:32:33Z: BRL livre
R$1.100,2577625, bloqueado zero; BNB livre 0,00663968; nenhuma ordem SOLBRL.
Dois engines existentes, BTCUSDT e SOLUSDT, permanecem no 01. Não havia engine
SOLBRL nem cap BRL. Essa leitura envelhece e NÃO autoriza ativar mais tarde sem
nova prova agregada de saldo/reservas. USDT/SOL alocados não financiam BRL.

A mesma credencial foi instalada no cofre do 03 com validação Binance e IP
167.71.37.166 às 16:53:38Z, conforme runbook de revalidação. A operação não
criou engine ou ordem, não copiou vault/HMAC/estado e não modificou a origem.

## Gate que impede a ativação experimental

O baixo consumo atual do Executor 03 é real; não é correto chamá-lo de lotado
com base apenas em `ceil(N/25) × 900`. Essa extrapolação também não certifica
100 slots. O inventário executável do transporte atual encontrou:

| Fluxo GET sintético, sem rede | Weight total |
| --- | ---: |
| Snapshot fresco | 54 |
| Query de ordem com relógio fresco | 5 |
| Trades com ownership e orderId | 14 |
| Ciclo estável, 25 ordens residentes | 395 |
| Ciclo estável, 100 ordens residentes | 770 |
| Reconciliação de 25 fills concentrados | 2.095 |
| Reconciliação de 100 fills concentrados | 7.570 |

O último caso contém 5.050 no host privado e 2.520 no público, antes de irmãos,
health, novos despachos ou retries. A soma é o custo do fluxo, NÃO uma medição
de taxa por minuto em Production; latência e agendamento influenciam a duração.
Ainda assim, não há prova de pacing/checkpoint que preserve o headroom por IP
durante esse caso. Não se pode certificar pelo estado estável apenas.

Certificação de bytes/Node/fleet não certifica carga N. A admissão passou a
exigir perfil de carga para a quantidade exata, versão de runtime e política,
com cenários de burst/retries/irmãos/recursos/fila. Certificados legados cobrem
25; ausência de perfil para 100 retorna `CAPACITY_UNKNOWN` com
`SLOT_WORKLOAD_UNCERTIFIED`, sem alterar os motores atuais. Fixtures com perfil
fictício demonstram o contrato SQL, não certificam hardware ou tráfego real.

Por isso, a proposta de 100 NÃO deve ser ativada nesta entrega sem evidência
adicional. Não reduzir quantidade, aumentar R$11, alterar capital ou forçar
admission. Não declarar insuficiência física definitiva: a lacuna demonstrada
é certificação/controle de carga de reconciliação para o novo perfil.

## Testes e limites

- Preparação 12/12, incluindo divisões periódicas e replay fail-closed.
- Testes integrados direcionados do root: 87/87, zero skips.
- Ownership de slot100 e inventário de peso: 5/5, GET fixtures sem rede.
- Transferência criptografada: 4/4 e revisão independente offline.
- Credencial já instalada: 35/35, incluindo rota ADMIN e provas negativas.
- UI 390/1440 px: 2/2; bloqueio de carga não certificada em 390 px: 1/1.
- Lint/typecheck relacionados e build Next.js: aprovados localmente. Mudança
  posterior de texto/reason na UI recebeu lint/typecheck e teste visual; build
  da Vercel deve confirmar o SHA final.
- Suíte ampla anterior registrou falhas em mocks legados de Testnet aposentada;
  não foram corrigidos por esta tarefa. Falhas novas de dependências do harness
  de ativação/ajustes foram corrigidas e seus testes direcionados passaram.

SQL/PGlite e fixtures não são provas de fills Binance reais, caos LIVE, custos
operacionais medidos ou capacidade de 100 slots. Nenhuma operação financeira
real foi usada para testar. Histórico de migrations local/remoto diverge em
timestamps antigos: aplicar somente a migration revisada, em transação, após
verificar ausência, e registrar somente essa versão pelo mecanismo oficial.

## Publicação e operação

Preencher evidência de migration, SHA, deploy, fleet parity, conexão03 e estado
final somente após a execução real. Até lá, código/testes não significam
Production liberada. Critério final para o experimental: todos os gates PASS,
incluindo carga exata, saldo fresco, filtros, taxas, whitelist e ownership;
caso contrário, nenhum engine REAL novo.
