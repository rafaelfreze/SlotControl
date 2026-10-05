# Caixeta SOLBRL — timeout de registry, 05/10/2026

## Evidência inicial

Produção CoinOps, Supabase `otdfpmsegjxpqrzisfmi`, schema `coinops`.
Web inicial `a9aaceae6db4a7bf71a7858351031a6b6e18941d`.
Incidente `5497fa54-4ff9-48c3-9667-addbd5b3273d`, executor-01,
engine `c87d9dc2-79f3-448e-aebd-46b44a1397c3`, run
`f600ebf4-7b5d-4ccc-be5c-6317d8342966`.

Vercel `/api/cron/live-execution`, 19:43:04 UTC (15:43:04 Campo Grande):
`COINOPS_OPERATOR_REGISTRY_READ_FAILED`, stage `trading_engines`,
code `TIMEOUT`, duration_ms `5004`. Não é erro Binance/ordem nem prova
de indisponibilidade permanente do banco; a causa da latência upstream
não foi preservada. O bug confirmado é o tratamento de timeout da leitura.

O alerta `COINOPS_OPERATOR_REGISTRY_UNAVAILABLE`, etapa `LOAD_LEDGER`,
ficou aberto às 19:43:09 UTC. Watchdog detectou às 19:43:46 UTC, não tentou
recuperação (assinatura fora da allowlist). Às 20:04:35 UTC: run ACTIVE,
last_error nulo, reconciliação 20:04:16, engine kill=true; pais ACTIVE sem
kill. Às 20:11:42 UTC, ledger com 25 slots, três posições/TP e uma NEXT BUY. Os demais
15 motores estavam saudáveis. Último fill desse SOL às 14:55 UTC, não
imediatamente antes do incidente. Nenhuma ordem foi usada para teste.

Leitura autenticada `/v1/state` pelo cliente oficial do Executor 01 às
20:13:41 UTC confirmou os mesmos IDs do ledger: TPs `428815808` (0,017 a
669,4), `429430633` (0,017 a 648,6), `431654500` (0,018 a 630,4), NEXT BUY
`431654533` (0,018 a 579,5), todos NEW/zero execução. Consulta sem POST de
ordem/cancelamento. Processo systemd 187361 permaneceu running desde 04/10.

## Correção e limites

- Prazo continua 5s por leitura completa do registry; somente timeout
  comprovado recebe uma segunda tentativa após 250ms. Relê operador,
  contas e engines, todas as páginas; nunca reusa autorização parcial/cache.
- Erro de permissão, identidade, registro ausente ou domínio inválido
  permanece fail-closed. Não inferir TIMEOUT só pela mensagem do provider.
- Timeout persistente tipado usa o checkpoint do fluxo normal: RETRY sem
  avançar last_reconciled_at; após cinco minutos persiste bloqueio local.
  Monitor não transforma esse timeout de observação em permissão negada.
- Alerta legado REGISTRY_UNAVAILABLE só é elegível com evidência LOAD_LEDGER
  e root correspondente. O cron normal precisa concluir reconciliação; a
  retomada sob lease relê escopo, saúde, ordens reais, ledger, TPs, caps e
  incidente único/inalterado antes de abrir o gate daquele engine.
- Retomada não envia/cancela ordem. O fluxo normal continua responsável
  pelo trading; Watchdog valida a saúde e encerra o incidente posteriormente.
- Não alterar SQL de flags, credenciais, estratégias, posições, TP, NEXT BUY,
  nem reiniciar VPS para esta correção web. Sem migration adicional.

## Regressões e operação

`operator-context-server-timeout.test.ts`: timeout único/persistente,
paginação 501 engines sem duplicação, novo prazo, permissão/tenant inválidos.
`live-observation-flow.test.ts`: checkpoint em LOAD_LEDGER, falta de freshness,
timeout persistente isolado, permissão não vira RETRY.
`live-read-recovery*.test.ts`: escopo fresco, incidente alterado, TP ausente,
saúde inválida, lease/CAS e isolamento. Relatório v18 publica regra v2.
O harness antigo de aporte não declarava dependências adicionadas por releases
anteriores (budget ACK/reserva e prova de não envio); foram atualizados apenas
os mocks isolados, mantendo as 31 asserções de preservação e idempotência.
Validação local: 254 testes passaram, três SQL opcionais de bulk sem banco
descartável configurado ficaram SKIP. Lint e typecheck aprovados; build Next
aprovado, com avisos preexistentes de CSS e Supabase/Edge. Nenhum teste SQL
foi apontado ao banco remoto. `fleet-parity --check-code` conservou o runtime
comum `65f2e382a441d5c51509d06a17e6ddfe74cef60c`.

Após deploy Git: observar cron e Watchdog sem disparar trades de smoke.
Exigir alerta resolvido pelo resume guardado, incidente RECOVERED,
gate aberto, 25 slots, TP/NEXT BUY correspondentes à Binance e reconciliação
recente. Registrar no incident_knowledge a assinatura exata com SHA/teste
somente após comprovar recuperação. Se qualquer prova falhar, manter bloqueio
local e investigar; nunca limpar alertas/kill switches manualmente.

Rollback: release web anterior. Não apagar ledger, incidente ou knowledge;
reabrir status de engenharia se a correção for revertida.
