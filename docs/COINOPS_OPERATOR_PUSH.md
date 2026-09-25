# CoinOps — notificações operacionais do operador

O push é observabilidade, não parte do loop de trading. O executor/cron LIVE mantém a única Strategy Engine. O cron independente `/api/cron/coinops-push` consulta alertas persistidos em `coinops.robot_v1_live_alerts` a cada minuto, detecta `ENGINE_HEARTBEAT_STALE` após 15 minutos sem reconciliação em motor REAL ativo e entrega Web Push aos dispositivos do operador. Falhas no push não enviam, cancelam nem substituem ordens.

## Configuração

Produção reutiliza as variáveis VAPID existentes no projeto Vercel `cripto`: `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (pública), `VAPID_PRIVATE_KEY` (somente servidor) e `VAPID_SUBJECT`. A chave privada nunca é enviada à UI. O endpoint administrativo autenticado `/api/coinops-push` entrega apenas a chave pública. Não colocar valores no Git ou em logs. Não girar esse par durante o rollout, pois dispositivos existentes usariam a chave pública anterior.

Em Automação → Configurações → Notificações, o ADMIN/OPERATOR ativa separadamente cada dispositivo. A permissão é solicitada por gesto do usuário, e a subscription é testada antes de ser salva. No iPhone compatível, é necessário adicionar o CoinOps à Tela de Início e abri-lo pelo ícone para receber Web Push com o navegador fechado. O service worker `/coinops-sw.js` só trata `push` e `notificationclick`; não faz cache de dados. [Documentação Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers).

## Escopo e auditoria

Subscriptions e entregas ficam em `coinops.operator_push_subscriptions` e `coinops.operator_push_deliveries`, com RLS forçada e acesso de dados apenas por service role no backend. A API valida Auth/operador/tenant e mesma origem. O browser não recebe endpoint ou chaves armazenadas de outros dispositivos. VIEWER não tem endpoint administrativo. Alertas são vinculados a operator/account/engine; um evento de Rafael não escolhe subscription de outro operador. O payload inclui somente nome da conta, par e motivo público allowlisted. Segredos Binance e `credential_ref` nunca entram no payload.

A chave de idempotência de entrega é `(alert_id, first_seen_at, subscription_id)`. Reconciliations sucessivas do mesmo incidente não recriam envio; reabertura após resolução reinicia `first_seen_at` e permite novo push. `attempted_at`, status, `device_count` e erro HTTP sanitizado registram a entrega. Falhas transitórias têm até duas novas tentativas com backoff; 404/410 desativam o endpoint expirado. Envio Web Push é confirmação do serviço de push, não prova física de que o usuário viu a notificação.

## Teste controlado

`Enviar notificação de teste` usa a subscription do dispositivo e cooldown de 60 segundos. `Testar alerta Testnet` cria alerta `TESTNET_PUSH_PROBE` em motor Testnet do próprio operador, sem chamar a Binance nem alterar trading. O cron envia pelo mesmo pipeline e resolve o alerta após envio ou após dois minutos sem dispositivo elegível. O toque deve abrir `/automacao?view=testnet&account=...&market=...&tab=alerts`; um alerta REAL abre `view=live` no mesmo escopo.

## Monitoramento

Verificar cron/VAPID, subscriptions habilitadas, entregas `FAILED`/`EXPIRED`, heartbeat, incidentes CRITICAL sem entrega elegível, deduplicação e deep-link. Se o cron de push estiver indisponível, o motor de trading não é afetado, mas a observabilidade deve ser marcada como falha. Não usar Codex Agendado como transporte push.
