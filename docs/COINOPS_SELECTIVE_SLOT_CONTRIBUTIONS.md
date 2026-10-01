# CoinOps — aporte seletivo por slots

## Contrato

`Aporte em slots selecionados` é uma operação administrativa de capital no
ledger CoinOps. Não é uma ordem Binance e não chama BUY, SELL, MARKET, TP ou
cancelamento diretamente. Após aporte aplicado, o reconciliador oficial
atualiza a NEXT BUY ainda sem fill no mesmo preço, conforme o
[protocolo de refresh](./COINOPS_NEXT_BUY_CAPITAL_REFRESH.md). Os modos preexistentes de gain, saldo individual e aporte em
todos os slots permanecem disponíveis.

O ADMIN escolhe uma conta, um único motor e de 1 a 25 slots físicos. A
distribuição pode ser igual ou personalizada. Toda quantia é validada em
centavos da moeda nativa (`BRL` ou `USDT`); na divisão igual, eventuais centavos
de sobra são atribuídos deterministicamente aos menores números de slot. A
soma das parcelas precisa ser exatamente igual ao total do batch.

## Ledger e estado

- `robot_v1_live_selective_contribution_batches` guarda o batch, origem,
  moeda, total, motivo, evidência, `request_id` e fingerprint idempotente.
- `robot_v1_live_selective_contribution_allocations` guarda uma linha por
  slot, com valor, estado observado, sequência da operação e estado
  `PENDING`, `APPLIED` ou `CANCELLED`.
- Um slot sem posição OPEN recebe o crédito em `balance_quote` e
  `contribution_quote` imediatamente. Isso não cria BUY adicional. Se já houver
  NEXT BUY sem fill nesse slot, o reconciliador redimensiona a ordem após
  confirmar caps, saldo e cancelamento seguro; os demais aguardam a estratégia.
- Um slot OPEN permanece byte a byte com o mesmo saldo operacional,
  quantidade, entry, TP, NEXT BUY, P&L e gain do ciclo. Sua alocação fica
  `PENDING`.
- Depois que a liquidação oficial do TP comprova o fechamento, registra o P&L
  exatamente uma vez e fecha o slot, a mesma transação aplica todas as
  alocações pendentes daquele slot. O próximo uso passa então a enxergar o
  capital novo.

O invariante contábil continua separado por dimensão: contribuição aplicada
compõe o principal; P&L realizado compõe resultado de mercado; aporte pendente
é compromisso auditável, mas ainda não compõe o saldo disponível do slot.

## Concorrência, segurança e isolamento

A confirmação exige preview vigente, saldo Binance livre suficiente e
fingerprint exato. A chave natural `(exchange_account_id, request_id)` é
serializada por advisory lock transacional, portanto clique duplicado, retry e
requisições concorrentes convergem para um único batch. O RPC é exclusivo de
`service_role`; tabelas possuem RLS forçada e leitura autenticada limitada ao
operador. Conta, motor, moeda, slot, saldo e `operation_sequence` são validados
novamente sob lock no banco.

Depois do commit do ledger, o web sincroniza os novos caps lógicos com o
executor do shard. O cap numérico da conta legada também é persistido no estado
privado do Executor 01, vinculado às identidades já instaladas; isso não altera
o namespace COR1 nem credenciais. Se a confirmação do executor se perder por
timeout, o backend relê o batch pelo mesmo `request_id` e repete somente a
sincronização idempotente do cap. O batch e suas allocations nunca são criados
novamente.

O fluxo funciona por identidade oficial de conta/motor, sem nomes de usuário,
ativos ou shards hardcoded. A aplicação após fechamento reutiliza a função
oficial de liquidação do TP; não existe uma segunda implementação de gain ou
reset.

## Operação e validação

O motivo de auditoria é obrigatório, com 3–160 caracteres após remover espaços
nas extremidades. A mesma validação atende todas as contas e shards: o formulário
mostra o erro junto ao campo e o focaliza antes de enviar a prévia; o backend
mantém a validação independente e retorna `COINOPS_ADJUSTMENT_REASON_REQUIRED`
ou `COINOPS_ADJUSTMENT_REASON_INVALID`. Esses erros ocorrem antes de consultar
o executor ou escrever batches/allocations. Não flexibilizar a auditoria para
contornar um erro de preenchimento.

No caso Dete de 28/09/2026, `COINOPS_ADJUSTMENT_INPUT_INVALID` vinha do motivo
vazio, não de diferença entre executores. A prévia autenticada de R$ 5.000
passou com o motivo preenchido; o ledger ainda tinha R$ 275 e nenhum batch de
aporte às 11:17:44Z. A validação da correção não registra aportes reais. Em
qualquer resultado incerto da confirmação, conferir o batch/request_id antes
de tentar novamente; nunca concluir que um aporte falhou só pela mensagem.

A interface mostra os 25 slots, capital atual, aporte pendente, OPEN ou
disponível, referência de entrada, gains e próxima utilização conhecida, com
filtros e preview completo. Smoke de Production é exclusivamente leitura e
nunca confirma um aporte real. As provas de mutação, retry e aplicação após TP
são executadas em PostgreSQL descartável.

Na tela administrativa da conta, `Slots da conta` resume cada motor em uma
linha compacta e abre a lista dos 25 slots. `Valor atual` é o saldo composto do
slot e já inclui aportes `APPLIED` e resultados realizados; `Aportado` lê o
acumulador `contribution_quote`/`contribution_brl`; `Pendente` soma somente
allocations `PENDING`. Portanto, o valor projetado após aplicação é `valor
atual + pendente`, nunca `valor atual + aportado`. O portal VIEWER usa a mesma
definição em `Ver detalhes` e `Ver ranking`, incluindo posição, P&L aberto,
P&L realizado e gains. Essas consultas são server-side e somente leitura.

## Predefinições de região

As predefinições são somente uma camada de seleção sobre o mesmo serviço. Os
modelos iniciais são `1 aberto + 4 abaixo` e `2 abertos + 3 abaixo`; o ADMIN
pode criar, editar, ativar ou desativar outros modelos informando total, slots
OPEN da âncora e quantidade seguinte abaixo. A ordem vem de
read model vigente da Strategy Engine, agrupada por estado operacional e rank,
nunca do número físico puro nem de previsão de mercado. Contrato compartilhado:
[ordem operacional](./COINOPS_OPERATIONAL_SLOT_PRESENTATION.md).

O resolver lista todas as regiões válidas e exige escolha explícita quando há
mais de uma. Os slots OPEN configurados precisam formar o prefixo consecutivo
da região; os demais são exatamente as próximas linhas operacionais. A lista
jamais dá a volta nem inventa slots depois do fim. Preview e confirmação
resolvem novamente `preset + âncora`; qualquer mudança no estado/ordem invalida
o fingerprint antes da escrita financeira.

O resultado do resolver é apenas `resolved_slot_ids[]`, entregue a
`apply_live_selective_contribution`. Preset não envia ordens, não muda a
estratégia e não possui ledger financeiro próprio. O uso do preset é auditado
separadamente e de forma idempotente pelo `request_id`; presets personalizados
nunca usados podem ser excluídos, enquanto presets padrão ou já usados são
preservados e apenas desativados.
