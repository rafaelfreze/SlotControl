# Saúde do Ativo — operação e entrega

## Escopo e fronteira

BTC e SOL inicialmente. Asset Health é informativo/read-only em relação ao trading. Não recomenda investimento, não prevê preço e não altera ordens, motores, estratégias, ciclos, slots, admission, Capacity Manager ou kill switches. Nenhuma credencial de exchange é usada. Não há LLM nem dependência do navegador/Codex para coleta.

Fontes públicas → coletor Vercel → normalização/última evidência válida → regras determinísticas → RPC transacional → snapshots/current/eventos → API autenticada → badges/drawer. Outbox de push separada reutiliza apenas o transporte Web Push existente. Watchdog verifica apenas o coletor; seu resultado não altera saúde/recuperação de engines.

## Frequências, custos e orçamento

- Cron `/api/cron/coinops-asset-health`: minutos 7 e 37, UTC; Production, `CRON_SECRET`, duração máxima 120s. Não criar tarefa Codex para operar este módulo.
- FAST: 30min, STRUCTURAL: 6h, DEVELOPMENT: 24h; TTL respectivamente 2h/12h/48h. Snapshot de regra expira em no máximo 90min.
- Lease do coletor 5min, cooldown entre tentativas 20min, fencing por UUID. Fontes com timeout9s, em paralelo, sem retry agressivo.
- 10 HTTP/rodada rápida, 6/estrutural, 6/desenvolvimento; aproximadamente510 requisições públicas/dia. Binance:4 HTTP/30min ao domínio market-data-only via Vercel; zero consultas autenticadas e zero requests nos IPs de executores. Limites públicos podem causar coleta parcial.
- 2 snapshots/rodada (~96/dia), 3 leituras pequenas por page load, sem APIs externas no frontend. Cache cliente5min/in-flight dedupe. Histórico filtra período30/90/365dias e até500 mudanças recentes combinadas; snapshots completos permanecem auditáveis no banco.
- Watchdog já existente adiciona uma leitura singleton/minuto e atualiza observação do coletor no máximo1vez/5min. Qualquer erro fica isolado do resultado operacional dos motores.
- Nenhuma API paga/assinatura nova. Não se afirma custo de infraestrutura zero: execução/armazenamento utilizam os serviços já inventariados em Custos & Operação. Não foi adicionado serviço fictício ao FinOps.

## Fontes, regras e evidência

Detalhamento completo em [Fontes e regras](./COINOPS_ASSET_HEALTH_SOURCES.md). Cada métrica guarda origem/URL, fetchedAt, observedAt, metricAt, value, status, confidence e erro quando disponível. Confiança não é probabilidade de perda.

HEALTHY exige cobertura mínima por categoria e fontes independentes. Indicadores são classificados como `CRITICAL`, `PRIMARY` ou `COMPLEMENTARY_PROXY`. Um proxy isolado pode aparecer como `OBSERVE`, mas não rebaixa o status global. ATTENTION exige ao menos dois sinais PRIMARY deteriorados de grupos independentes, ou um CRITICAL confirmado, de alta confiança. STRUCTURAL_RISK exige deterioração crítica não-proxy em2categorias e2fontes independentes, confirmada por novas observações por6h. Ausência/stale é INSUFFICIENT_DATA. GET pode degradar validade, nunca renovar evidência ou criar nova escalada estrutural. Preço/candle/retorno não é entrada permitida; TVL e volume DEX não são sinais de risco.

## Persistência e segurança

Migration `20260927110357_add_coinops_asset_health.sql`, projeto oficial `otdfpmsegjxpqrzisfmi`, schema `coinops`:

- `asset_health_collector_state`: singleton, cadências, lease, status/falhas, duração e observação Watchdog.
- `asset_health_snapshots`: evidências e regras imutáveis por ativo/data.
- `asset_health_current`: ponteiro/assessment atual.
- `asset_health_events`: transições antes/depois, trigger, reasons, timestamp e snapshot com métricas/fontes.
- `asset_health_deliveries`: outbox por evento/dispositivo, tentativas/lease/resultado.
- RPCs `asset_health_claim`, `asset_health_finish`, `asset_health_fail`: `SECURITY INVOKER`, search_path vazio, grants service_role. Finish valida lease novamente, timestamps monotônicos e transaciona ambos ativos/cadências/eventos. Replay ou worker antigo não publica.
- RLS habilitada e forçada nas5tabelas, sem grants anon/authenticated; acesso exclusivamente pelo backend validado. Histórico sem UPDATE/DELETE nem para service_role, com trigger adicional.
- API GET exige usuário e operador CoinOps ativo no tenant oficial; VIEWER precisa vínculo ativo + conta/operador no tenant. POST de sync é ADMIN-only, mesma origem, não aceita escopo/provider/force do cliente e respeita lease/cooldown.
- Secrets permanecem nos envs existentes Vercel; nenhum secret novo, frontend ou histórico. APIs públicas de dados não recebem credenciais.

## UI

Mesmos cards BTC/USDT e SOL/USDT na Home Todos, badge compacto e idade da análise. Drawer reutiliza o diálogo portal com close fixo/foco/Escape; status, explicação, categorias, cobertura e histórico. Riscos/condições/fontes/detalhes técnicos recolhidos. Deep link `?assetHealth=BTC|SOL` por allowlist. Não existe novo card grande.

## Alertas e monitor

Transições estruturais HEALTHY↔ATTENTION↔STRUCTURAL_RISK produzem evento auditado. Bootstrap, estado igual ou ida/volta de dados insuficientes não geram push de deterioração. O evento de indisponibilidade continua auditado e o monitor de coleta evidencia o problema.

Entrega somente a dispositivos habilitados cujo user_id corresponde ao ADMIN/operador ativo do tenant CoinOps. Warning opt-out preservado; risco estrutural e recuperação dele não são suprimidos. Dedup único event/device, claim condicional, lease90s, até3tentativas, retry na próxima rodada30min, eventos expiram para envio após24h. Falha de push não desfaz snapshot nem interfere em trading.

Entrega física é at-least-once: crash entre send e registro SENT pode reenviar; tag/topic estáveis substituem a mesma notificação no dispositivo. Não afirmar exatamente uma entrega física nem recebimento no iPhone a partir de testes mock. Nenhum alerta artificial deve ser criado em Production só para validar push.

## Operação e diagnóstico

1. Ler collector_state e current, comparar last_success_at/validUntil/fetchedAt/observedAt.
2. Fonte falhando: olhar errorCode e último valor; não inferir falha do ativo. Optional ausente é lacuna declarada, não falha operacional do coletor.
3. Cron parado: conferir Deployment READY/main, configuração cron e logs da rota; preservar snapshots e ordens.
4. Primeira coleta: aguardar próximo tick ou usar POST autenticado ADMIN da API. Nunca escrever valores inventados no banco.
5. Histórico: sem dados anteriores ao primeiro deploy. Conclusões novas sempre possuem snapshot/trigger/reasons.
6. UNKNOWN/source unavailable: informar limitação. Não contratar API, provisionar recurso ou alterar trading para conseguir verde.

## Validação

- Regras/fontes:23testes incluindo proxy isolado, quórum PRIMARY, CRITICAL confirmado, preço extremo, fontes conflitantes, persistência, APIs fora e stale.
- Serviço/auth/cron:11testes; push:8testes; UI:6testes. Total44 direcionados sem SQL.
- SQL:10/10 em PostgreSQL17 descartável real; concorrência, fencing, rollback, imutabilidade, RLS/grants e delivery dedupe. No Windows o start PostgreSQL exigiu permissão do sandbox; não foi falha da migration.
- UI:12cenários Chromium/WebKit em320/360/375/390/430/1280px; close após scroll, Escape, sem overflow, história/dedupe. WebKit é emulação, não iPhone físico.
- Lint/typecheck/build no fechamento. Evidência de publicação, primeira coleta real e smoke registrada no relatório da entrega.

## Rollback

Reverter apenas commit do módulo ou restaurar deployment anterior `1c40e4a` (inclui correção dos gains). Remove cron/UI/integração do coletor; manter as tabelas e histórico (aditivos) sem apagar evidência. Não reimplantar executores, não modificar secrets, não restaurar ledger nem cancelar ordens. Se somente fonte falhar, não fazer rollback de trading; módulo mostra coleta parcial/stale.

## Limitações deliberadas

Diversidade instalada por stake/cliente, Nakamoto atual agrupado por operador e feed completo de vulnerabilidades ainda indisponíveis. A coleta por conta de voto permanece rotulada `COMPLEMENTARY_PROXY`; não equivale ao Nakamoto por operador e não participa sozinha do quórum global. Liquidez de uma exchange não é liquidez global. Dados externos não garantem inexistência de risco, segurança econômica, preço futuro ou retorno. Observação temporal real de30/90/365dias só existirá após o respectivo período.
