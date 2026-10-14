# Cadastro de clientes e primeiros passos

Em **Automação > Configurações > Usuários / Acessos**, o administrador ativo cadastra exatamente cinco dados: e-mail, senha inicial (mínimo 8 caracteres), empresa, dono e WhatsApp. A conta Binance não é um requisito para criar o acesso. O papel é sempre VIEWER, definido no servidor.

O cliente cadastrado pelo administrador entra diretamente com a senha escolhida, sem confirmação por e-mail nem troca obrigatória. O cadastro público usa os mesmos cinco dados e mantém a confirmação de e-mail vigente do Auth. Ambos abrem **/primeiros-passos** enquanto não houver conta vinculada. A tela explica configuração e segurança; não movimenta capital e não lê contas, ordens ou resultados de terceiros.

O administrador usa **Vincular conta** depois do cadastro. O endpoint confirma uma conta própria, faz atualização condicionada ao vínculo ainda vazio e não ativa motores ou executor. Os controles existentes de desativação, correção de vínculo inativo e recuperação continuam separados. E-mail existente, inclusive em outro produto compartilhado, não recebe uma senha nova nem transferência de acesso.

Backend: OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`. A migration `coinops_deferred_viewer_setup` altera somente a exigência do vínculo inicial, adiciona dados de contato e instala triggers filtrados para **novas** identidades `onplay_product=coinops`. O registro público aponta para um operador CoinOps ativo comprovadamente único; novos operadores não mudam esse registro automaticamente. O papel do usuário não vem de `user_metadata`. Não foram alteradas configurações globais de Auth, senhas, contas Binance ou permissões operacionais existentes.

Origin/JSON, projeto, schema e operador ativo são conferidos pelo endpoint administrativo. A senha vai apenas à API oficial de Auth. Chamadas administrativas têm limite de 15 segundos. Resposta incerta é reconciliada pelo mesmo request/ator/operador, sem repetir redefinições. O diretório Auth não retorna ao navegador. RLS bloqueia o papel VIEWER de permissões de operador mesmo se ele adquirir uma membership inadequada posteriormente.

QA é derivado somente no fluxo administrativo para `onplay-qa-...@example.test` e empresa iniciada por `QA ONPLAY `. O objeto `app_metadata.onplay_qa` contém produto, run_id e exclusões de billing/analytics/publicação. Esses usuários são excluídos da descoberta e dos novos vínculos comerciais. O público não pode definir esse marcador. Nenhuma conta, ordem, ledger, cobrança, e-mail ou mensagem real é criada pelos testes locais. QA real autorizado fica sob o checkpoint central da operação.

A página pública agora usa passos de configuração e não exibe rendimentos, saldo ou desempenho fictícios.
