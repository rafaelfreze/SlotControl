# Fase 5.0 — auditoria adversarial do ledger

Baseline: `3b967b7d974af46ef715b6369f8d97168cc74ae5`. Escopo: ajustes 4.4,
aportes USD/BRL, reversals, contabilidade OPEN/fechado e interação com
liquidação Testnet. Nenhuma consulta ou mutação remota foi necessária para
estas provas. O estado real e a publicação são registrados no relatório
principal da Fase 5.0.

## Findings e correções

| ID | Severidade | Causa comprovada | Correção |
| --- | --- | --- | --- |
| LEDGER-01 | HIGH | No PostgreSQL, o RPC aceitou BRL com `fx_source = NULL`; `IF` e `CHECK` avaliavam UNKNOWN. | Comparação `IS DISTINCT FROM` e constraint explícita de evidência FX não nula. |
| LEDGER-02 | HIGH | `fx_rate = 'NaN'::numeric` atravessava validação SQL e podia produzir saldo/lançamento `NaN`. O teste executado no baseline não gerou a exceção esperada. | RPC rejeita números não finitos; constraints de ledger e contas rejeitam valores não finitos, inclusive em gravações diretas privilegiadas. |
| LEDGER-03 | HIGH | Crédito Testnet era evento + PATCH absoluto de saldo em requisições separadas. Um ajuste concorrente ou crash entre evento e PATCH podia perder o aporte ou deixar gain sem crédito. | `credit_robot_v1_testnet_closed_slot` trava run/slot, verifica lease e prova de fechamento, soma lucro ao saldo atual e grava eventos/estado na mesma transação. |
| LEDGER-04 | MEDIUM | Preview/SQL dependiam de `entry_state=OPEN` e BUY `FILLED`; uma execução parcial ainda ARMED ou terminal cancelada perdia a evidência de posição/capital comprometido. | A exposição Testnet deriva de BUY − SELL − taxas base da operação corrente; a evidência preserva o quote original das BUY. Shadow também reconhece PARTIALLY_FILLED. Não altera posição nem ordem. |
| LEDGER-05 | LOW | Retry de reversal com mesma chave e motivo diferente retornava sucesso no atalho da server action. | Motivo normalizado também integra a comparação de idempotência; o RPC continua protegendo fingerprint completo. |
| LEDGER-06 | MEDIUM | Falhas de consulta do ciclo/slot Shadow eram silenciosamente representadas como ausência de posição. | Preview falha fechado com `POSITION_UNAVAILABLE`. |

As guards de FX corrigem a fronteira SQL mesmo que o cliente TypeScript já
rejeitasse NaN. O RPC é somente service-role e a UI não fornece um caminho
direto para executar SQL arbitrário. Não foi demonstrado abuso remoto por
usuário comum; a severidade reflete a possibilidade de corrupção da
contabilidade em uma integração privilegiada futura.

O crédito Shadow existente foi revisado: `credit_robot_v1_shadow_operation`
trava a conta `FOR UPDATE`, insere crédito único por operação e soma o P&L
ao saldo travado na mesma transação. Não usa o PATCH absoluto vulnerável do
Testnet; não houve reimplementação desse fluxo.

## Prova de execução SQL

Arquivo: `apps/web/lib/slotgain/audit-5-ledger-sql.test.ts`.
PostgreSQL local 17.10, cluster efêmero exclusivo, `127.0.0.1:55441`.
O harness cria seus próprios papéis e fixtures; não lê `.env`, Supabase,
credenciais, contas, configurações ou dados reais. Remove variáveis PG
herdadas, usa endpoint explícito e inicia processos sem janela. Cada
cenário financeiro termina em `ROLLBACK`; o cluster é encerrado ao final.

A migration 4.4 e as três migrations 5.0 são executadas pelo PostgreSQL,
não interpretadas por regex ou substituídas por um modelo TypeScript.
A função e o trigger mensal originais são carregados literalmente da
migration 4.2, depois substituídos pela migration 5.0. As tabelas
anteriores e o helper compartilhado de autenticação são fixtures mínimas:
isso prova os grants/RLS dos objetos testados, mas não substitui a
verificação remota do helper oficial de membros/tenants/usuários ativos.

Migrations executadas:

- `20260923221727_add_robot_v1_manual_slot_adjustments.sql`;
- `20260923231728_harden_robot_v1_manual_adjustments.sql`;
- `20260923231731_harden_robot_v1_testnet_partial_accounting.sql`;
- `20260923231734_guard_testnet_order_submission.sql`.

Comando reproduzível, a partir de `apps/web`:

```powershell
node --experimental-strip-types --test lib/slotgain/audit-5-ledger-sql.test.ts
```

`COINOPS_AUDIT_PG_BIN` aceita outro diretório local de binários PostgreSQL
Windows. Sem PostgreSQL, a suíte identifica os casos como SKIP, não PASS.
Neste PC a inicialização do PostgreSQL exige execução fora do token
restrito do sandbox; o processo permanece limitado ao cluster efêmero
explicitamente criado para estes testes.

## Matriz contábil

Foram exercitados em SQL:

- OPEN 100 + aporte 5 + lucro realizado 2 = saldo seguinte 107, mantendo
  BUY, quantidade, preço e TP exatamente iguais durante o aporte;
- ganho manual + reversal: dois registros imutáveis e saldo/contadores
  restaurados; retries não criam terceiro registro;
- USD e BRL: conversão exata, metadados de FX e zero gain por aporte;
- FX NULL, NaN, vencido e no futuro: falha e rollback integral;
- preview stale e chave repetida com valor diferente: falha sem saldo novo;
- Shadow OPEN/fechado: capital inicial + lucro + ajuste reconciliam;
- Testnet ARMED com BUY parcial e Shadow PARTIALLY_FILLED: posição
  existente/quote comprometido corretos, ordens e preços imutáveis;
- SELL completa retira a evidência OPEN mesmo com projeção de slot atrasada;
- lease de motor ativo: ajuste bloqueado em Shadow e Testnet;
- crash depois de ajuste: saldo, ledger e gains voltam juntos;
- UPDATE/DELETE no ledger: trigger imutável;
- anon/authenticated: EXECUTE privilegiado e INSERT negados;
- SELECT próprio permitido e outro tenant sem linhas;
- carry de ciclo Testnet + reversal de ganho do ciclo anterior: principal
  intacto, componentes carregados uma vez, gain local não fica negativo;
- reversal de mês anterior preserva gains do mês atual, retirando somente
  o fato original e seu lifetime correspondente;
- REAL preparado permanece isolado das contas Shadow/Testnet;
- três transações concorrentes com rollback serializam o mesmo ajuste;
- liquidação atômica com aporte anterior, retries, lease vencida e
  posição ainda não encerrada;
- crash histórico `SLOT_CLOSED` antes do PATCH: recuperação usa o saldo
  atual, preserva o fato mensal já existente e adiciona lucro uma vez;
- crash após crédito atômico: estado CLOSED, saldo, evento e gain fazem
  rollback juntos;
- SELL cancelada com fechamento quantitativo completo passa pela prova
  compartilhada e pelo trigger mensal real;
- permissão durável de envio: CAS consome uma vez, timestamp não pode ser
  apagado, PREPARED legado continua apenas leitura de recuperação.

A prova longa usa seed `448155`, 2.000 ajustes, 500 reversals e 2.000
replays imediatos: 4.500 chamadas ao RPC e exatamente 2.500 registros.
A cada ajuste reconstrói independentemente `100 + SUM(delta)` e
`SUM(gain_units)` do ledger, comparando com a conta. Aportes não viram gain
nem lucro de mercado. Tudo é descartado via rollback.

## Limites da evidência

Os testes não afirmam ter operado uma exchange, testado dinheiro real ou
validado autenticação humana/SSO. A concorrência exercitada usa três
transações com rollback; unicidade e replays também são exercitados no
RPC real. Os cenários de crash são interrupções transacionais injetadas e
fixtures do estado legado, não encerramento físico do host de produção.
Execução do novo RPC e das constraints locais não constitui aplicação
remota de migrations; isso pertence ao fechamento principal.

Production continua READ-ONLY; LIVE bloqueado; zero operação financeira real.
