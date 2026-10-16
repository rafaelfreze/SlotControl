# Cadastro imediato e confirmação opcional — 16/10/2026

Produto: coinops. Backend: otdfpmsegjxpqrzisfmi / coinops.

O cadastro público usa POST /auth/signup com os cinco dados essenciais. O servidor valida os dados, o plano quando aplicável e a origem, consome o limite persistido e cria apenas uma identidade nova. Duplicidade não altera senha, identidade, role, membership ou empresa existente. O mesmo servidor autentica com a senha escolhida e entrega cookies antes de abrir o onboarding. Não há envio obrigatório de confirmação nessa etapa.

Auth recebe email_confirm:true somente para permitir o acesso. Isso não declara posse do endereço: app_metadata.onplay_email_ownership contém version, product, status pending e o e-mail normalizado. Os cadastros novos pelo Master mantêm o mesmo marcador. Contas legadas sem marcador mantêm a semântica anterior; este código não faz backfill nem modifica sessões existentes.

O aviso no painel é opcional e nunca bloqueia uso. A ação authenticated revalida getUser e usa signInWithOtp com shouldCreateUser:false, remetente/transporte oficial e callback existente (/auth/callback?intent=ownership). Apenas uma credencial válida no callback permite marcar verified e verified_at, preservando o restante de app_metadata. Login por senha ou clicar no aviso não constitui confirmação. Falha de envio mostra mensagem e preserva o acesso.

Limites por hora: 5 tentativas por e-mail, 10 por origem de rede, 100 globais do produto. Chaves são HMAC server-side; o banco não recebe e-mail nem IP em texto. A tabela tem RLS e sem grants públicos. A RPC é somente service_role, possui checagem de role e lock transacional. Unicidade Auth impede duplicação; resposta incerta orienta login, sem repetir criação ou redefinir credencial.

O cadastro continua criando apenas VIEWER sem conta Binance vinculada. A função/trigger existente resolve o operador, membership e papel. Primeiros passos não configura credencial, ativa motor ou movimenta capital. O callback de confirmação conserva os guardas atuais.

Não há alteração global do Supabase Auth, configuração de MFA, recovery, billing, fiscal ou execução financeira. A migration aditiva deve estar aplicada no projeto/schema acima antes do código. Histórico/checksum e aplicação remota são coordenados na operação principal, sem db push global.

Validação segura: testes dos handlers com adaptadores simulados, callbacks, criação Master e controle de estado da UI; lint, typecheck e build. Nenhuma ordem, engine, mensagem ou conta real é usada como teste de compilação.

