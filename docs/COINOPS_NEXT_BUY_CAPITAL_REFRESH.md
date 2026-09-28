# NEXT BUY após aporte — 2026-09-28

## Causa e correção

O planejador mantinha `HIGHEST_PRIORITY_BUY_ALREADY_RESIDENT` quando a melhor
entrada continuava no mesmo slot, sem avaliar o novo capital. O ledger e os
caps cresciam, mas a quantidade da BUY residente não mudava.

O reconciliador LIVE agora reconhece aporte APPLIED posterior à preparação da
ordem (allocation seletiva ou item de ajuste positivo do mesmo operador,
conta/motor/moeda/slot). Calcula a quantidade com o step Binance, arredondando
para baixo e respeitando capital, caps, exposição, saldo livre e filtros.
O Strategy Engine mantém sua grade, prioridade, meta, ciclo e preço; somente
gera CANCEL_REPLACE_NEXT_BUY para atualizar a quantidade de uma entrada
residente elegível. Não dispara MARKET nem complementa posição existente.

## Gates antes de cancelar

- BUY/ENTRY NEW, zero quantidade e quote executados, slot ARMED sem posição;
- preço não cruzado, mesma entrada escolhida pela estratégia;
- incremento de pelo menos um quantityStep e fonte de aporte persistida;
- executor anuncia `supports_unfilled_buy_cancel` e seus `execution_caps`
  atuais comportam os limites do ledger e o novo notional;
- lease renovada; identidade de account/engine/market/order validada no fluxo
  oficial. Sem capability/cap sync, mantém a ordem antiga e aguarda.

O cancelamento usa chave `CANCEL_UNFILLED:<clientOrderId>`, separada do
cancelamento protetor existente. A Binance recebe `cancelRestrictions=ONLY_NEW`.
Se o GET anterior ou posterior detectar fill parcial/total, reconcilia e
protege a posição; não volta o slot para PLANNED nem cria BUY complementar.
O P&L e TP seguem exclusivamente o fill real. O saldo extra fica disponível
para uso futuro, nunca aumenta a posição já comprada.

## Crash, retry e resultado incerto

Cancelamento CANCELED + zero fills + trades reconciliados é checkpoint
persistente. ARMED sem residente só volta a PLANNED quando essa prova existe
na operação atual; desconhecido/partial/SELL nunca autoriza restauração.
Se o preço cruzou durante o intervalo, as regras normais da estratégia
continuam soberanas: não inventar fill nem enviar MARKET para compensar.

Após timeout, consulta-se o MESMO ID. PREPARED e submission_guarded_at
impedem reenvio cego. Nova revisão gera um único clientOrderId; retries leem
essa ordem. Resultado ambíguo permanece fail-closed no motor afetado. Não
prometer recuperação automática quando a exchange não comprovar o resultado.

O Watchdog reutiliza o reconciliador, sem segunda estratégia. Eventos
`NEXT_BUY_CAPITAL_REFRESH_PLANNED` e `NEXT_BUY_CAPITAL_REFRESH_CONFIRMED`
preservam IDs antigo/novo, capital sources, quantidades, preço, moeda e
timestamps. Relatórios v13 certificam somente evidência persistida completa;
plano sem confirmação é WARNING, não sucesso inferido.

## Evidência inicial (somente leitura)

Binance × ledger conferidos em 2026-09-28T02:24:48Z:

| Motor | Slot | Capital | BUY antes | Preço mantido | Quantidade esperada após step |
|---|---:|---:|---:|---:|---:|
| Rafael SOLBRL | 3 | 21 BRL | 0,018 SOL / 10,9836 BRL | 610,2 | 0,034 SOL / 20,7468 BRL |
| Thyely SOLUSDT | 2 | 59,76 USDT | 0,139 SOL / 16,65081 USDT | 119,79 | 0,498 SOL / 59,65542 USDT |

Rafael slot 2 conserva +10 BRL PENDING; Thyely slot 1 conserva +43 USDT
PENDING. As BUYs BTC não têm esses aportes e não são alvo de substituição.
Nenhum batch ou capital novo foi criado durante a investigação.

## Validação e publicação

Testes locais isolados de sizing/rounding, partial/race, cancel ONLY_NEW,
timeout/query exato, idempotência, caps e crash. Nunca criar aporte/trade real
para smoke. Publicar web com versões anterior+nova explicitamente validadas,
depois executores por shard, preservando state/vault/ordens e rollback.
No fechamento, reler Binance/ledger, comparar TPs por ID/preço/quantidade,
verificar eventos, zero duplicação e reconciliação dos demais motores.

Fonte técnica: [Binance Spot — cancel order](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/trade).

## Checkpoint de entrega — publicação autorizada

Base local/GitHub main conferida: `89523c3afd43e03c96944f4069bbb892542a17e8`.
Executor 01 fonte `97a1666a2a3f18ef5ff007ce3ccf6ce442f22ea3`, versão anunciada
`97a1666`. Executor 02 fonte/versão `fd567fe613108c0c7e2ae7bed57cd02ed7ff7d30`.
Ambos responderam HEALTHY em leituras anteriores ao rollout. Até esse checkpoint
pré-publicação, nenhum deploy, cancelamento, ordem, aporte ou mudança de capital
havia sido executado nesta tarefa; o resultado posterior está registrado abaixo.

Código revisado inclui a correção, auditoria v13 e testes. Validação final:
75/75 testes do executor e 79/79 testes direcionados web (incluindo 20 cenários
da orquestração, sizing/planner, relatórios e janela de versões). Lint,
typecheck e build finais passaram após os refinamentos de headroom, restauração
ARMED e janela UTC. Smoke real é separado destes testes isolados.

A publicação foi retomada após autorização explícita do proprietário para
aceitação temporária de APENAS versão antiga+nova revisadas por shard. A janela
possui início/fim UTC e fecha automaticamente na nova versão; não modifica
HMAC, IP, credenciais, permissões ou gates financeiros. O banner e o fluxo por
engine usam a mesma resolução de versão. A variável JSON de shards contém
secrets e não deve ser reconstruída nem impressa. Ver o runbook de deploy.

Nova conferência GET Binance em 2026-09-28T09:55:30Z: Rafael SOLBRL ainda possui
a BUY #3 original de 0,018 SOL a 610,2, zero fills. Seus TPs #1/#2 permanecem
respectivamente 428506130 / 428555677. Thyely SOLUSDT #2 preencheu naturalmente
antes desta publicação: 0,139 SOL a 119,79; NÃO é mais alvo de resize. O fluxo
oficial criou TP 17889827957 (0,139 a 126,38) e NEXT BUY #3 17889829286
(0,514 a 116,2 = 59,7268 USDT), já usando o capital aportado. TP #1 17884454734
permanece 0,142 a 130,99. Esses fills não foram provocados pela validação.

Passos autorizados naquele checkpoint: revisar diff isolado; build final; commit local;
configurar versões exatas não secretas antes do push/main; confirmar Vercel
READY; atualizar cada VPS pelo SHA publicado com rollback, state/vault
preservados; aguardar reconciliador oficial e validar Binance × ledger × TPs
e relatório de refresh. Não repetir aportes. Não incorporar a alteração
preexistente `docs/COINOPS_WATCHDOG_DIOGO_20260927.md` nem scripts untracked
alheios. O novo `inspect-account-orders-readonly.mjs` pertence a esta tarefa.

## Resultado Production — 2026-09-28, 10:24 UTC

Publicado em main `89ce0d3237f7c2509acd9c87958ba4dbb6bf3f63`; Vercel
`dpl_HzwSdhB7e92U6nCFMNjd8wP6561k` READY. Ambos os executores passaram a essa
versão. A janela autorizada 10:02:39.350Z–10:22:39.364Z encerrou automaticamente
a aceitação das versões antigas; a configuração NEXT continua necessária até
promoção atômica para a base, nunca removê-la isoladamente.

O reconciliador confirmou Rafael SOLBRL em 10:15:34.864870Z: BUY antiga
`COR1-SOL-3-1-BUY-bf2320acf5b9a6` CANCELED com execução zero; nova
`COR1-SOL-3-2-BUY-f20720377ddd80` / Binance `429448011`, NEW, 0,034 SOL a
610,20 BRL (20,7468 BRL). A única ordem nova nos runs atuais desde 10:00 foi
essa substituição autorizada. GET Binance às 10:20 confirmou quantidade/preço,
os TPs preservados por ID/quantidade/preço e as ordens BTC/Thyely inalteradas.
Não foram criados novos aportes nem trades de teste.

Incidente da publicação: o procedimento inicial desta execução usou umask 077
no checkout legado e tornou três arquivos de código ilegíveis ao serviço.
EACCES derrubou temporariamente Executor 01; o primeiro rollback repetiu a
permissão. Leitura do código corrigida e serviço anterior restaurado 10:13:28Z;
nova versão instalada após import como usuário real do serviço. Não atribuir
esta falha à Binance, gain ou aporte. Preflight versionado passa a bloquear
essa condição antes do restart, inclusive rollback e novos shards (runbook de deploy).

Dois engines ficaram fail-closed com `COINOPS_LIVE_ARM_ENTRY_FAILED`:
Rafael BTCBRL, incidente `89b6aeab-3c2d-4dfc-a369-af489de160fb`, e Thyely
SOLUSDT, `a379cb3a-33fd-432a-81ed-253bd7ff0b0e`. Após reconciliação e prova
Binance × ledger, foram retomados individualmente por `/api/cron/live-control`
RESUME (OPERATOR_CONTROL), 10:21:31.817943Z e 10:22:05.351415Z. Nenhum SQL
manual limpou flags/alertas; nenhuma allowlist genérica foi ampliada. Watchdog
detectou e confirmou RECOVERED, mas não executou o RESUME (`actions_taken=[]`).

Consultas 10:23:05–59Z: 11/11 engines/runs ACTIVE; 275 slots/contas de slot;
20 OPEN/20 TP; 11 BUY/11 ARMED; todos os kill switches falsos. Zero críticos
ou incidentes abertos, PREPARED, terminais sem conciliar, duplicações ou
divergências TP/posição e BUY/slot. RECONCILED posterior ao RESUME em ambos.
Health autenticado por engine às 10:24:11–21Z confirmou 11/11 ACTIVE com
versão real exata, IP próprio, Binance OK, flags e relógios válidos.
Comparação agregada das 11 contas de slots com o snapshot de 10:00:41.697710Z:
saldos, contribuições, P&L realizado, quantidade de gains e slots permaneceram
iguais após a recuperação. A substituição da BUY não contabilizou aporte/gain novamente.

O painel possuía ciclos independentes de atualização (capacidade 30s, snapshot
RSC até 120s), podendo mostrar observações de instantes distintos. A correção
visual usa mudança de versão/estado por IP como sinal de refresh deduplicado,
não como prova de saúde nem autorização para pintar verde. Atribuir todo o
primeiro print apenas a essa defasagem permanece INFERIDO; a indisponibilidade
durante o deploy e os dois incidentes subsequentes são COMPROVADOS.

Validação adicional: build web/lint/typecheck PASS; testes focais do health,
sincronismo e deploy; preflight somente leitura passou nos dois VPS com UID/GID
reais sem reinício. Não houve migration/RLS. Smoke visual autenticado no Chrome
não foi possível porque a integração disponível não expôs a sessão Chrome;
não declarar iPhone/Safari físicos validados a partir desses testes.
