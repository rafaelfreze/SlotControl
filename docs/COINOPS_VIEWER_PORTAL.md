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

Convite e recuperação usam o redirect CoinOps direto para `/redefinir-senha`, aceito pela allowlist do hook de e-mail compartilhado. O token de sessão chega no fragmento da URL e é consumido pelo cliente Auth no próprio formulário, sem redirecionamento server-side intermediário. A versão anterior mandava o link para `/auth/callback?next=%2Fredefinir-senha`: o primeiro clique confirmou o usuário no Auth, mas o formulário abriu sem sessão; a repetição do link retornou token de uso único inválido. O hook existente usa o provedor transacional configurado da plataforma; aceitação pelo provedor não comprova entrega na caixa principal, então o recebimento deve ser confirmado com o destinatário sem criar convites de teste para pessoas reais.

Em 24/09/2026, uma tentativa atingiu a allowlist, mas o hook retornou `AUTH_EMAIL_PRODUCT_NOT_RESOLVED`: durante o evento `invite`, o usuário recém-gerado ainda não estava visível à RPC de identidade. O hotfix restrito a `action=invite` e `product=coinops` usa o e-mail do payload Auth assinado quando a RPC devolve zero identidades; não modifica os demais produtos nem dispensa a verificação de redirect. A função compartilhada `auth-email-multiproduct` passou da versão 8 (`db058bc68c12282c3b5e4e2c689ca6cd9787ec763c4495d4c28d40d06fb7591e`) à versão 9 (`42464106b76b375861ec8c6702937879d01ba3e9b01c496e3199a76ddc1c6a6f`). A versão 10 (`56bdaf704e1049c7b0120d892992072ad8dbe273f355180db61fb4fae55fcb44`) acrescentou exclusivamente `/redefinir-senha` à allowlist CoinOps para eliminar o salto server-side; os outros produtos permanecem inalterados. O terceiro convite foi entregue e o usuário/vínculo persistiram, mas a senha não foi criada devido ao salto intermediário. Um link novo de recuperação, não um novo convite, deve concluir o cadastro após o deploy do redirect direto.

## Semântica exibida

O portal separa capital operacional do ledger, resultado de mercado realizado e P&L aberto estimado por moeda. A leitura direta do saldo Binance é assíncrona; quando falha, mostra somente o último snapshot de validação com horário e aviso de desatualização. O preço público é referência visual, não preço de execução. Valores de moedas distintas nunca são somados.

## Verificação obrigatória antes de convidar pessoa real

Validar Auth invite/recovery em ambiente publicado, política RLS de `viewer_access`, negativa de acesso cruzado e de métodos de escrita, leitura de saldo do executor e smoke mobile. O convite depende da configuração de entrega de e-mail do Supabase Auth. Não usar conta real de terceiro como fixture de teste.
