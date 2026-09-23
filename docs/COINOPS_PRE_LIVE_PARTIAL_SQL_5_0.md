# Fase 5.0 — prova SQL de fechamento parcial e restart

Migration: `20260923231731_harden_robot_v1_testnet_partial_accounting.sql`. Alvo semântico exclusivo: tabelas `coinops.robot_v1_testnet_*`. A aplicação remota e o SHA final são registrados no relatório consolidado; este documento registra os testes locais.

## Causa e correção

**HIGH — fechamento parcial terminal:** o cálculo de execução pode comprovar uma posição vendida com residual inferior ao step, mesmo quando a última SELL termina CANCELED/EXPIRED. O trigger mensal e o restart SQL exigiam literalmente FILLED. A matriz reproduziu a falha original `COINOPS_MONTHLY_TESTNET_GAIN_EVIDENCE_INVALID` no PostgreSQL real, usando o corpo original do trigger da migration4.2. Após a correção, a mesma fixture passa.

`private.coinops_testnet_operation_closure` concentra a prova quantitativa usada pelo crédito atômico, trigger mensal e restart. Ela exige escopo run/slot/operação; ordens terminais; trades reconciliados quando há execução; quantidade, quote e fees finitos e não negativos; ausência de fee externo não valorado; preço da SELL positivo; BUY/SELL executados; residual menor que quantityStep e nenhuma sobrevenda além da tolerância numérica1e-10. Retorna lucro líquido, quantidade, dust, última SELL, preço/status e horário de fill quando existe evidência. Não realiza escrita nem acessa exchange.

**MEDIUM — restart inseguro com inputs incompletos/idempotência cruzada:** o SQL anterior deixava NULL atravessar comparações e retornava qualquer execução existente pelo reset key. O novo contrato rejeita NULL/NaN/Infinity, confere predecessor/escopo/terminal/anchor do retry, rejeita todos25 META BATIDA e preserva25 slots. EXPIRED_IN_MATCH foi acrescentado ao check de status; é expansão aditiva da lista aceita.

**MEDIUM — crédito mensal duplicado por novo evento:** o trigger agora serializa run/slot e rejeita outra source_id para a mesma operação já creditada. A idempotência regular do mesmo event_key/source_id continua preservada.

**HIGH — revisão de TP não determina a competência:** a SELL de maior revisão pode preencher antes de um residual de revisão anterior. O helper usa o maior `filledAt` de todas as SELL executadas da mesma operação para `effective_gain_at`, independentemente da ordem de coleta. A identidade da SELL de fechamento permanece estável para idempotência. O teste cobre revisão2 ainda em setembro e residual da revisão1 já em outubro; o crédito pertence a outubro.

Se qualquer SELL executada não possuir evidência temporal, o fechamento contábil comprovado continua permitido, mas o horário exato fica nulo no helper. O trigger mantém `TESTNET_CREDIT_FALLBACK` explícito e usa a data de crédito; não inventa fechamento no mês anterior a partir de evidência parcial. Os relatórios deixam essa competência em WARNING. Isso não interfere na proteção de posições OPEN.

A prova detalhada de fechamento parcial está em `SLOT_CLOSED.details.execution` (`quantityStep`, `closingSellClientOrderId`, `remainingDust`, `terminalStatus`). Eventos FILLED antigos continuam aceitos pelo contrato anterior durante o deploy; parcial terminal nunca usa esse caminho de compatibilidade. Horário da reconciliação não substitui horário de fill para atribuição do mês quando o fill está disponível.

## Testes locais executados

`apps/web/lib/slotgain/audit-5-partial-sql.test.ts`: **16/16 PASS**, PostgreSQL17 descartável em127.0.0.1:55442. Initdb cria cluster temporário, cada cenário usa transação/rollback, pg_ctl encerra ao final. Nenhuma `.env`, credencial ou configuração Supabase vinculada é lida.

- BUY10/50/99% terminal e TP correspondente;
- SELL parcial terminal com dust comprovado;
- múltiplas revisões TP, fees e EXPIRED_IN_MATCH;
- residual não encerrado, ordem ativa e trade não conciliado;
- oversell, NaN e fee de outra moeda sem valorização;
- lucro divergente, evento duplicado e rollback sem resíduos;
- fill03:59:59.999Z/credit04:01Z na virada Campo Grande;
- múltiplas SELL com fills/coleta fora de ordem e revisão anterior fechando no mês seguinte;
- ausência de horário em uma SELL executada mantém fallback de crédito explícito, sem antecipar competência;
- FILLED legado compatível e parcial sem prova rejeitado;
- restart gera25 slots e retry não duplica ciclo;
- prova adulterada rejeitada;
- NULL/NaN/data infinita e idempotency key de outro predecessor rejeitados;
- todos25 com meta impedem novo ciclo; inputs do próximo período permitem;
- anon/authenticated sem EXECUTE no helper e restart.

```powershell
node --experimental-strip-types --test lib/slotgain/audit-5-partial-sql.test.ts
```

As tabelas pré-requisito são fixtures sintéticas; helper, trigger e restart são os SQL versionados reais. Isso prova os contratos SQL exercitados e privilégios locais, não RLS/usuários reais do Supabase nem preenchimentos remotos da Binance. No Windows deste executor, processos PostgreSQL requereram execução fora do token restrito; o alvo permaneceu o cluster descartável loopback. Production READ-ONLY, LIVE bloqueado e zero operação financeira real.
