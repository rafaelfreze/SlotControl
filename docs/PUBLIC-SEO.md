# SEO institucional público

A homepage anônima usa a origem oficial `https://cripto-flax.vercel.app/` como canônica e URL Open Graph. A configuração fica na própria página raiz: não é uma canônica herdada pelas telas privadas. Login e redirecionamento autenticado permanecem nativos.

`/sitemap.xml` lista somente a homepage institucional, sem contas, usuários, APIs ou painéis. `/robots.txt` aponta esse sitemap e exclui as rotas nativas de autenticação e operação. Diretivas de robôs não substituem Auth, RLS ou segurança de acesso.

O inventário da Central reutiliza `POST /api/marketing/platform-source` com `operation: discover`, `externalTenant: platform` e o HMAC institucional existente. Não há nova ponte, segredo, migration ou consulta central ao banco CoinOps. Publicação e sitemap não comprovam indexação nem métricas Google Search Console.

Nenhum caminho financeiro, worker, cron, ordem, ledger, tenant ou fingerprint operacional foi alterado.

A mesma configuração pública fornece imagem Open Graph/Twitter absoluta com o ícone CoinOps nativo de512px, sem criar outro asset ou promessa comercial. Um único JSON-LD `WebSite`/`WebPage` é emitido somente pela homepage anônima, depois do guard de sessão existente; contém apenas marca, descrição pública e canônica oficiais. Não infere entidade jurídica, rentabilidade, saldo, preço ou dados individuais. Metadados e schema compartilham as constantes públicas, evitando configuração manual divergente. Testes semânticos preservam as rotas privadas fora do sitemap e não autorizam indexação dessas rotas nem execução financeira. Schema presente não comprova indexação ou rich results.
