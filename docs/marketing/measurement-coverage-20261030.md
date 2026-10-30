# Medição operacional — 30/10/2026

## Cobertura

Site institucional público. Não coleta operações financeiras, slots ou informações privadas.

Núcleo compartilhado marketing-premium 1.3.2. Distribuição ESM compilada do mesmo artefato, com manifesto SHA-256, sem alteração de dependências ou fingerprint financeiro.

## Contagem e limites

Visualizações visíveis e cliques reais em links HTTPS wa.me, api.whatsapp.com e web.whatsapp.com; telefone separado. Captura antes da navegação, sem impedir WhatsApp. A origem é classificada apenas quando legitimamente disponível, sem guardar URL completa, mensagem, cookies, identidade, telefone, IP completo ou identificadores de publicidade. Sem reconstrução de sessão. Um UUID efêmero por envio serve apenas para repetição/deduplicação, nunca como visitante.

Fetch keepalive, uma repetição limitada em falha de rede/servidor reutilizando o recibo e deduplicação no servidor. Bloqueadores, falta de rede e encerramento do navegador podem impedir coleta: não há garantia de cobertura integral. Cliques não são pessoas únicas, conversas, leads qualificados ou vendas.

## Consentimento

A contagem agregada permitida não depende da autorização publicitária. Aceitar, recusar e não escolher não bloqueiam conteúdo nem WhatsApp. Controles de preferências são acessíveis e não bloqueantes. Meta continua condicionado à autorização aplicável. Google Consent Mode avançado já existente é preservado com consentimento inicial negado, sem cookies publicitários nem identificadores de clique antes do aceite; implementações básicas não são convertidas para avançado. Não presumir aceite e não copiar carregamento presumido de terceiros.

## Central e isolamento

Painel nativo: apps/web/app/automacao/marketing/page.tsx. Central Master Fiscal seleciona uma empresa por vez e usa o mesmo DTO agregado e cálculo do painel nativo. Sites institucionais usam escopo platform e HMAC dedicado onplay-website-aggregate-v1; não se misturam com empresas nem finanças. Produto, backend e schema são validados no servidor. Auth/RLS e guards nativos permanecem.

Datas novas usam America/Campo_Grande; histórico não é reescrito. Cobertura parcial e fontes indisponíveis aparecem explicitamente; não substituir ausência por zero. Eventos autorizados, Contact recebido pelo Meta e conversas confirmadas permanecem separados. Sem fonte de recepção Meta/conversa, o indicador permanece indisponível. Nenhuma conversão publicitária nova é criada.

## Validação e publicação

Fixtures isoladas verificam recibos repetidos, DTO, escopo, RLS e grants. Testes de navegador/transporte não enviam conversões ou contatos reais. Build e smoke de publicação são registrados no relatório central da execução. Nenhuma campanha, lance, orçamento, ID, label, dataset ou público é alterado.
