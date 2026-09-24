# Meu CoinOps — acesso de cliente somente leitura

O operador existente continua usando `/automacao`. Um `VIEWER` é uma identidade do Supabase Auth vinculada por `coinops.viewer_access` a exatamente um `exchange_account` e um `operator`. O convite é enviado pelo Auth e leva à definição de senha; não há senha local na tabela.

## Fronteira de segurança

- O browser do cliente só acessa `/meu-coinops` e o GET `/api/coinops-viewer-state`. Não há parâmetro de conta ou motor nesses leitores.
- O servidor autentica o usuário, resolve o vínculo ativo e consulta dados somente daquele `operator_id` + `exchange_account_id` + motor Real. A resposta de saldo expõe apenas saldos, preços e horário, nunca ordens brutas, IDs ou credenciais.
- A tabela de vínculos tem RLS de leitura própria e nenhum grant de escrita para `authenticated`. `private.coinops_can_access_row` nega as permissões antigas de operador a toda identidade presente em `viewer_access`, inclusive se ganhar um vínculo de plataforma posteriormente.
- O middleware bloqueia as rotas e APIs administrativas para `coinops_role=VIEWER`; os endpoints administrativos também exigem o operador ativo no banco. Desativação marca o vínculo inativo imediatamente e bane o login no Auth. JWTs já emitidos podem viver até expirar, mas deixam de autorizar o CoinOps por causa do vínculo consultado a cada acesso e da RLS.
- Nenhuma operação nesta camada cria, cancela ou substitui ordens Binance. O GET de saldo usa a leitura autenticada existente do executor.

## Administração

Em Automação → Configurações → Usuários / Acessos, o operador escolhe uma conta existente e envia convite. Também pode redefinir senha, desativar, reativar ou revogar acesso. O fluxo não cadastra terceiros automaticamente. Um e-mail já vinculado ao mesmo operador não cria novo vínculo.

Convite e recuperação usam o redirect CoinOps `/auth/callback?next=%2Fredefinir-senha`, aceito pela allowlist do hook de e-mail compartilhado. O navegador preserva o fragmento de sessão no redirecionamento para o formulário de senha. Uma tentativa anterior com redirect direto para `/redefinir-senha` era rejeitada pelo hook (`AUTH_REDIRECT_NOT_ALLOWED`) antes de criar o usuário ou enviar e-mail. O hook existente usa o provedor transacional configurado da plataforma; aceitação pelo provedor não comprova entrega na caixa principal, então o recebimento deve ser confirmado com o destinatário sem criar convites de teste para pessoas reais.

## Semântica exibida

O portal separa capital operacional do ledger, resultado de mercado realizado e P&L aberto estimado por moeda. A leitura direta do saldo Binance é assíncrona; quando falha, mostra somente o último snapshot de validação com horário e aviso de desatualização. O preço público é referência visual, não preço de execução. Valores de moedas distintas nunca são somados.

## Verificação obrigatória antes de convidar pessoa real

Validar Auth invite/recovery em ambiente publicado, política RLS de `viewer_access`, negativa de acesso cruzado e de métodos de escrita, leitura de saldo do executor e smoke mobile. O convite depende da configuração de entrega de e-mail do Supabase Auth. Não usar conta real de terceiro como fixture de teste.
