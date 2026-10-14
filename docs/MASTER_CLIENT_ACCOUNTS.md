# Cadastro administrativo de clientes

O cadastro fica em **Automação > Configurações > Usuários / Acessos**. O administrador ativo escolhe nome, e-mail, senha inicial (mínimo 8 caracteres) e uma conta Binance própria já cadastrada. O papel é sempre VIEWER; não é possível criar administrador por esse formulário.

O cliente entra em Meu CoinOps diretamente com esses dados, sem confirmação por e-mail ou troca obrigatória. **Trocar senha** abre o formulário autenticado existente. Convite e recuperação por e-mail continuam opcionais.

Backend confirmado: OnPlay Platform `otdfpmsegjxpqrzisfmi`, schema `coinops`. O endpoint verifica projeto, schema, operador ativo, Origin/JSON e ownership da conta antes de acessar Auth. A senha vai somente a `auth.admin.createUser`, nunca a tabelas, metadata, auditoria, logs ou resposta. O papel VIEWER é definido atomicamente no Auth; acesso sem vínculo válido é bloqueado por middleware/RLS.

E-mail existente não tem senha sobrescrita nem vínculo automático. A identidade Auth pode ser compartilhada com outros produtos; use o fluxo de recuperação existente quando apropriado. Repetição do mesmo request/ator/conta pode reconciliar uma criação cuja resposta se perdeu, sem redefinir senha. A recuperação Auth é limitada a 20 páginas de 100 usuários server-side; diretório e credenciais não retornam ao navegador. Resultado incerto exige readback antes de outro cadastro.

Nenhuma conta Binance, chave, motor, capital, ordem ou contrato comercial é criada por esse cadastro. O vínculo financeiro continua centralizado no OnPlay Fiscal/FinOps. Os testes usam mocks; não criar usuários reais como smoke.
