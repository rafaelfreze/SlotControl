# Fase 5.2 — executor LIVE sem escrita

O código oficial permanece em `github.com/rafaelfreze/SlotControl`, branch `main`. A Strategy Engine e o ledger continuam no CoinOps/Supabase (`otdfpmsegjxpqrzisfmi`, schema `coinops`). O servidor apenas valida pedidos assinados, consulta a Binance Production e calcula dry-runs com a mesma engine, sem transporte de ordens nesta fase.

## Infraestrutura

- DigitalOcean Basic Shared CPU Regular: 1 vCPU, 1 GiB RAM, 25 GiB SSD, 1 TB de transferência, US$ 6/mês (US$ 0,009/h), sem backup ou banco pago. IPv4 público incluído; impostos/IOF/câmbio podem elevar a cobrança final.
- Ubuntu 24.04 LTS, região Frankfurt FRA1, Droplet `coinops-live-executor-fra1`, IPv4 `46.101.104.48`. Este IP pertence ao Droplet enquanto ele existir; recriar o Droplet pode mudá-lo. Não foi contratado Reserved IP.
- HTTPS: certificado Let's Encrypt para o próprio IPv4, válido por cerca de seis dias e renovado por timer systemd a cada 12 horas, com reload do Nginx. Verificar periodicamente o timer e o certificado; falha de renovação bloqueia o acesso antes de permitir tráfego inseguro.
- Nginx expõe somente 80 (desafio ACME/redirecionamento) e 443 (proxy TLS). O serviço Node escuta exclusivamente `127.0.0.1:8080`. Firewall permite apenas 22/80/443; SSH aceita chave, não senha. Estado e env privados.

## Limites de segurança

- `TRADING_ENABLED=false` e `KILL_SWITCH=ON` são exigidos no startup e não podem ser substituídos por request.
- Não existe cliente Binance de escrita ou rota que crie/cancele ordens. `/v1/create-order`, `/v1/cancel-order` e `/v1/cancel-all-orders` respondem bloqueio antes de qualquer chamada externa.
- Apenas `REAL` + `DRY_RUN` + BTCBRL/SOLBRL + versão da Strategy Engine correta entram no cálculo. BTCUSDT, SOLUSDT, margin, futures, transferência, saque e ações genéricas não possuem transporte.
- Defesa adicional: BTC R$ 450 total/R$ 18 por ordem; SOL R$ 275 total/R$ 11 por ordem; global R$ 725; 25 slots. Request não pode ampliar esses valores.
- `POST /v1/dry-run` requer HMAC SHA-256 de método, rota, timestamp, nonce e hash do corpo. Janela de 30 segundos, nonce único e idempotência persistida em disco (conclusões e claims), com bloqueio de claims pendentes.
- `GET /health` não contém segredo. Só marca `healthy=true` se os GETs públicos da Binance funcionam, o relógio tem drift <= 2 s, a chave Production consultada é somente leitura e o IPv4 observado coincide com o configurado.
- Os GETs públicos repetem no máximo uma vez após falha de rede ou HTTP 5xx; HTTP 429 e demais 4xx falham fechados. O drift é medido no intervalo da própria consulta de horário, sem confundir uma cotação paralela lenta com atraso de relógio.
- Os logs incluem request ID, decision ID, hash curto da chave de idempotência, symbol, resultado, latência, flags e horário, sem HMAC/segredo/cabeçalho de autorização.
- A chave privada SSH dedicada reside apenas no perfil local deste PC, fora do Git. As credenciais Binance e HMAC devem residir somente em env de serviço restrito e configuração server-side Vercel, nunca no frontend, Git ou relatórios.

## Operação e gate

O `LIVE_EXECUTOR_READY` requer, em conjunto: IPv4 confirmado, TLS público válido/renovação, health, HMAC/anti-replay, caps, allowlist, flags de bloqueio, GETs Binance Production pelo IP do executor, dry-run BTC/SOL igual ao da Fase 5.1, observabilidade e zero escrita. Se qualquer verificação faltar, o gate é `ATTENTION`/pendente. Mesmo em PASS, LIVE permanece bloqueado.

O painel Real lê `LIVE_EXECUTOR_BASE_URL` e `LIVE_EXECUTOR_EGRESS_IP` **somente no servidor** e exibe o health, incluindo a região declarada no executor por `COINOPS_EXECUTOR_REGION`. `LIVE_EXECUTOR_VALIDATED_VERSION` fica ausente até o smoke assinado e a validação READ-ONLY do SHA correspondente; a presença dessa variável apenas libera a exibição do gate quando o health ainda confirma os bloqueios e o IP. Nenhuma dessas variáveis habilita trading.

O botão “Validar dry-run BTC/SOL” faz um `POST` autenticado em `/api/coinops-live-executor/diagnostic`. A rota resolve produto/tenant/usuário pelo backend, lê configurações Real e caps do banco, constrói intenções BTCBRL/SOLBRL no servidor e assina cada request com `COINOPS_EXECUTOR_HMAC_SECRET` (Secret da Vercel Production). Não aceita intent, símbolo ou valor do browser. O executor valida novamente caps e filtros; a resposta resume 25 slots/ativo e `NO_WRITE`.

Comandos de diagnóstico no servidor: `systemctl status coinops-live-executor`, `systemctl status nginx`, `systemctl list-timers coinops-certbot-renew.timer`, `journalctl -u coinops-live-executor`, `ufw status` e `curl https://46.101.104.48/health`. Nunca copiar env/segredos para logs ou tickets.

A Fase 5.3, separada, poderá pedir ao proprietário cadastrar o IPv4 na whitelist da Binance e habilitar somente Spot Trading. Esta fase **não** altera whitelist, permissões da API, LIVE ou saldo, e não cria/cancela ordens reais.

## Evidência operacional da Fase 5.2

- GET autenticado Binance Production executado no Droplet e reportado pelo health como `READ_ONLY`; IPv4 de saída `46.101.104.48` confirmado. `TRADING_ENABLED=false`, `KILL_SWITCH=ON` e porta de aplicação restrita a `127.0.0.1:8080`.
- Vercel Production enviou HMAC server-side para o mesmo executor e recebeu `NO_WRITE` em BTCBRL e SOLBRL: 25/25 slots válidos em cada par. O primeiro diagnóstico sofreu falha transitória isolada em BTC; a leitura GET ganhou retry limitado e a medição de drift foi corrigida. O diagnóstico subsequente passou em ambos (BTC 1.310 ms, SOL 2.098 ms). São amostras de smoke, não SLA/p95.
- Amostra curta de seis latências de dry-run Vercel→executor→Binance: 1.286, 1.293, 1.294, 1.310, 2.098 e 2.268 ms; p50 aproximado 1.302 ms, p95 observado aproximado 2.268 ms (n=6, não representa SLA). A requisição que falhou antes da correção foi excluída destes percentis e permanece registrada como warning histórico.
- TLS público válido; renovação Let's Encrypt com `certbot renew --dry-run` aprovada. Firewall libera apenas SSH, 80 e 443; SSH exige chave e desabilita senha. Arquivo de env do executor é `root:root` modo `600`, estado do serviço modo `700`.
- Os testes do executor cobrem HMAC/tamper/anti-replay, idempotência, parity com Strategy Engine, hard caps, negação de create/cancel, retry GET e clock paralelo. A chave Binance Production foi copiada apenas para o env privado do servidor, sem mudança de permissões/whitelist e sem exposição no Git/UI/logs. A cópia original na Vercel permanece temporariamente para não quebrar o painel existente.
- `LIVE_EXECUTOR_READY` é um gate de infraestrutura e não autorização de trading. Para a Fase 5.3, revalidar saldo, filtros, permissões, whitelist, relógio, certificado, configurações e caps; a execução real exige decisão e autorização separadas.
- No smoke final, um fill fictício BTC Testnet expôs `COINOPS_MONTHLY_SLOT_COUNT_INVALID`: a checagem mensal de uma BUY preparada recebia apenas o slot candidato, embora a política exija 25 slots. A checagem agora recarrega o snapshot completo do mesmo ciclo/tenant antes da elegibilidade e continua falhando fechada se o plano estiver incompleto. A suíte local de 512 testes, incluindo o caso reproduzível, passou; a reconciliação publicada deve ser confirmada após o deploy.
