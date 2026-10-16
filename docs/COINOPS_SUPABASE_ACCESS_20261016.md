# CoinOps — acesso técnico ao Supabase

## Alvo invariável

- Produto: CoinOps, repositório `rafaelfreze/SlotControl`, release GitHub/main.
- Projeto: **OnPlay Platform**, ref `otdfpmsegjxpqrzisfmi`.
- Organização: `pzgqtvaitaawqgaabxve`; schema operacional **coinops**.
- Não criar outro projeto nem usar `public` ou outro produto como fallback.

## Diagnóstico confirmado em 16/10/2026

O connected app/MCP Supabase lista somente a organização Ads/Fiscal Dev e
retorna acesso negado para o Platform. A autenticação está funcional para esse
escopo, mas não há evidência para atribuir o erro a token expirado ou banco
offline. O CLI já autenticado lista o Platform como ACTIVE_HEALTHY e executa
consultas no schema correto via Management API. Isso é uma alternativa técnica
oficial, não uma correção da autorização OAuth do connected app.

O proprietário escolheu continuar pela CLI. A reconexão do MCP pode ser feita
posteriormente autorizando a organização Platform; não revogar acesso de Ads
ou de outros produtos para contornar essa diferença.

## Verificação reproduzível e somente leitura

Executar `tools/operations/check-coinops-supabase-access.ps1` com a CLI oficial
2.121+ disponível no PATH, parâmetro `-CliPath` ou cache npm já instalado.
O script reutiliza o login, verifica organização/ref, força transação READ ONLY
e confirma sete tabelas principais, RLS/FORCE RLS e migrations CoinOps.
Não lê tokens, chaves de serviço, senhas nem dados de credenciais Binance.

Se houver falha para gravar telemetria em `~/.supabase`, isso é uma permissão
local, não prova de falha de autenticação. Solicitar a execução técnica com
permissão adequada; não extrair tokens para a linha de comando.

`db query --linked --project-ref otdfpmsegjxpqrzisfmi` usa a Management API.
Revisar a ajuda da versão instalada antes de usá-la. Consultas de diagnóstico
devem ser READ ONLY e explicitamente qualificadas em `coinops`. O resultado da
CLI contém o último SELECT; agrupar evidências em um JSON quando necessário.

Os `.env.local` encontrados neste checkout apontam um backend legado e não
declaram `SUPABASE_DATA_SCHEMA=coinops`. Eles **não** são a fonte de autenticação
da CLI nem uma alternativa autorizada para migrations ou leituras financeiras.
Não substituir secrets ou puxar todo o ambiente Production para resolver acesso.

## Migrations e testes

Confirmar schema e histórico remoto antes de criar migration versionada com
`supabase migration new`. O Platform compartilha infraestrutura com outros
produtos: divergência no histórico geral não autoriza aplicar em lote todas as
migrations deste checkout. Revisar somente o DDL CoinOps pretendido, registrar
o alvo e verificar se já foi aplicado. Nunca executar testes financeiros contra
o projeto vinculado; usar banco efêmero/local e rollback.

Uma consulta READ ONLY bem-sucedida prova leitura técnica, não prova aplicação
de migration, deploy, saldo suficiente, autorização Binance ou readiness LIVE.
