# CoinOps — Central de Estratégia e aportes em massa

## Escopo e publicação

Código oficial: `rafaelfreze/SlotControl`, `main`; app `apps/web`, executor `apps/live-executor`, backend OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`. Este documento descreve os contratos implementados; deploy, smoke e funcionamento LIVE precisam de evidência separada. Nenhum fluxo de preview deve criar ordens, cancelar ordens ou movimentar capital.

## Central de Estratégia

Em Automação → Real → Estratégia, o operador autenticado seleciona uma conta Binance validada, moeda BRL ou USDT e BTC, SOL ou ambos. Ele define o capital autorizado, sua divisão exata entre motores e os percentuais de gain, spacing normal e pós-ATH. O padrão é 25 slots; a soma das parcelas deve igualar o cap da conta em centavos, sem arredondamento que invente capital. A meta mensal continua 7 gains por slot BTC e 2 SOL. O preview consulta saldo livre, filtros e cotação atuais da Binance pelo executor e não grava nem envia ordens.

`PROVISION` grava apenas motores e preparações inativos com kill switch ligado, de forma idempotente. `SYNC` replica somente esse registry inativo no executor. `PREPARE` cria o ledger/ciclo de 25 slots antes de qualquer dispatch. `ACTIVATE` exige novo snapshot de saldo e ordens, promove apenas o motor escolhido, verifica gates e dispara o worker normal. O status `OPERANDO` requer prova de slots, posição OPEN, TP, uma NEXT BUY, reconciliação recente e ausência de alertas; não é inferido apenas de um clique ou de `status=ACTIVE`. Pausar e retomar continuam por motor, com reconciliação antes de novos writes. Motores existentes Rafael/Thyely não são reprovisionados por essa central.

## Ajustes e plano mensal

Em Automação → Real → Ajustes, o operador escolhe conta e quote específicas. O gain manual acrescenta unidades de gain ao slot e à meta/rank mensal, sem adicionar P&L de mercado. O aporte de capital pode ir para um slot ou ser dividido por 25 slots de um ou dois motores. A soma dos centavos distribuídos é idêntica ao valor informado. Posição OPEN, entry, quantidade e TP permanecem intactos; o novo saldo de slot só serve para uma operação futura.

Preview e confirmação são separados por hash, snapshot recente da Binance, ownership, reconciliação, cap e request ID idempotente. A conversão BRL→USDT registra valor de origem, USDT efetivamente recebido, taxa efetiva, referência pública USDTBRL fresca e evidência; não movimenta dinheiro. Aporte não gera gain. A reversão é um lançamento compensatório imutável e é bloqueada depois de operação/ajuste posterior que comprometa o valor. As tabelas de batches/items, a fonte de ganhos mensais e o relatório `APORTES.csv` preservam a trilha de auditoria. A alteração de cap no banco deve ser sincronizada ao registry do executor; falha nessa sincronização é erro explícito e a mesma requisição pode ser repetida com segurança.

O plano mensal (por exemplo, R$ 1.000 divididos 50/50 durante 24 meses) é **somente planejamento**. Salvar ou desabilitar um plano não credita saldo, não altera cap e não agenda aporte financeiro automático. Aporte real exige uma confirmação administrativa individual após o dinheiro estar disponível na conta correta.

## Segurança e isolamento

As rotas aceitam apenas sessão do operador atual, origem canônica e intent administrativa; resolvem conta/motor no servidor. Os RPCs são `service_role`-only e aplicam lock, comparação de saldo/cap/seqüência, identidade física, unicidade e RLS. `VIEWER` não recebe ações administrativas. O executor usa HMAC, credencial server-side e allowlist do registry; nenhuma das novas rotas de preview ou de ajuste envia create/cancel/replace à Binance. Rafael e Thyely permanecem isolados por account ID, engine ID e moeda de cotação.

Migrations aditivas em `coinops`: `20260925024845_add_operator_engine_provisioning`, `20260925024857_add_live_operator_adjustments`, `20260925024909_add_live_operator_adjustment_reversal` e `20260925024922_add_live_contribution_plans`. Antes de aplicá-las em outro ambiente, confirmar ref, schema e histórico; nunca reaplicar sem checar o estado remoto. O contrato de relatórios correspondente é `report_version=11`.
