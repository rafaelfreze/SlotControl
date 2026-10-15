# Push somente para bloqueios operacionais persistentes — 15/10/2026

## Evidência e causa

O proprietário recebeu, às 10:24 America/Campo_Grande, vários pushes genéricos
`Robô requer atenção operacional`. O dispatcher anterior enfileirava qualquer
CRITICAL e WARNING habilitado, sem consultar resultado, recovery ou lease do
Watchdog. Produzia ainda um segundo conjunto próprio de alertas de heartbeat.
TTL de uma hora podia entregar um aviso depois da recuperação. Falha de auditoria
após aceitação pelo provedor e lease SENDING vencida podiam repetir o transporte.

Os logs oficiais Vercel mostram dez falhas `COINOPS_LIVE_CAPITAL_AUDIT_UNAVAILABLE`
no cron iniciado 14:22:04Z, com resumo em 14:23:01.131Z, request
`fhvmn-1792074124415-ee8620d67200`, deployment
`dpl_HGgLz9TEfiiwoFq7Np2DkHUjzZrY`. Isso explica uma origem comum para a rajada,
mas logs não substituem a auditoria das deliveries nem provam recebimento físico.
Ver a correção separada da observação de capital.

## Contrato de envio

- Apenas REAL, ADMIN ativo e subscription habilitada do mesmo operador/usuário.
- Alerta raiz CRITICAL aberto, run, account, engine, símbolo, shard e código
  exatamente associados ao incidente aberto do Watchdog.
- Bloqueio persiste ao menos 120s; checagem e last_seen do Watchdog têm até 150s.
- BLOCKED com resultado OPEN/BLOCKED_SAFE; RECOVERING nunca escala. Lease ativa
  adia até 10min de bloqueio estável. Após esse limite, prova Watchdog fresca e
  exata ainda bloqueada pode notificar apesar da lease: o worker também a usa
  para proteger TP/fills de um motor bloqueado, não só para recuperá-lo. Isso
  evita silenciar indefinidamente um bloqueio por alinhamento de horários dos crons.
- PAUSED intencional não notifica. Falha real de proteção num PAUSED ainda pode
  notificar quando existir a mesma prova de bloqueio.
- Nova fotografia completa depois do claim e antes do transporte. Leitura
  incompleta/obsoleta é UNKNOWN: adiar, não declarar resolvido ou enviar por palpite.
- Um carrier canônico raiz por run; não multiplicar pelo alerta WATCHDOG derivado.
  Consultar entregas anteriores do mesmo episódio/código/ownership. Qualquer
  carrier já aceito ou de resultado incerto impede outro envio; SENDING concorrente
  adia, sem ultrapassagem por UUID ou timestamp. Uma causa nova após encerramento
  pode ser um novo episódio legítimo.
- Retry até três somente após rejeição HTTP explícita 429/5xx. Timeout/transporte
  incerto ou SENDING vencido não são autorização para repetir. Aceitação seguida
  de falha de auditoria nunca volta ao retry HTTP. 404/410 desabilitam subscription.
- TTL operacional de 60s. Teste solicitado pelo usuário mantém contrato próprio.
- Título `BLOQUEIO PERSISTENTE`, com causa pública allowlisted ou código sanitizado;
  nunca secret, payload de ordem ou resposta do provider no corpo.

Avisos de mercado/Saúde do Ativo, recovery e capacidade são informativos e ficam
somente no painel. Seu coletor, eventos, gates e histórico não são alterados.
Indisponibilidade real do executor continua escalando pelo pipeline de
infraestrutura, somente como EXECUTOR_OFFLINE CRITICAL persistente e confirmado
por incidente/checagem Watchdog do mesmo shard.

O dispatcher não cria/resolve alertas financeiros, não retoma BUY, não toca ordens
nem assume responsabilidade pela recuperação. Nenhuma migration ou restart VPS.
Não há garantia de exactly-once física de Web Push; em dúvida prefere-se não
duplicar o transporte e manter a evidência administrativa. Notificações já
entregues ao iOS não podem ser recolhidas pelo servidor.

## Verificação

`npm run test:push` executa o dispatcher real contra Data API/provider em memória.
Inclui recovery rápido, bloqueio persistente, race de resolução, ownership,
same-symbol/cross-shard, duas instâncias, troca derived→root, empate de timestamp,
falha após aceitação, timeout, assinatura expirada e TTL. Não enviar push físico
nem provocar incidente financeiro em Production para smoke.

Pós-publicação: confirmar SHA READY, cron sem erro, deliveries elegíveis somente
para bloqueio atual, checagens Watchdog e reconciliação. Ausência de acesso ao
dashboard/banco não autoriza afirmar todos os gates saudáveis.

Validação pré-publicação: 60 testes de notificações + 97 regressões de
Watchdog/ledger/capital/recovery PASS; lint direcionado, typecheck e build PASS.
Build local isolou Supabase em loopback sem credenciais operacionais, sem chamadas
financeiras. Health autenticado GET-equivalente dos executores 01/02/03 em
14:52:02/13/21Z: HEALTHY, Binance OK, IP verificado, runtime comum
8dc5eb49de9ceb63ff63ffd643c8354645623808. Isso não certifica os gates dos dez motores.
Imagem do proprietário em 10:52 confirma cinco saudáveis, um PAUSED monitorado
e dez bloqueados pela auditoria de capital; não confundir classificação do shard
com processo VPS indisponível. A extensão Chrome foi reconectada pelo proprietário,
mas a ferramenta continuou sem carregar sua política interna; MCP Supabase não
tem acesso à organização do projeto. Usar logs oficiais e não inventar leitura DB.
