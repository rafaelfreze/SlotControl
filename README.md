# SlotGain Control

Web app para controle pessoal de operações cripto por slots. Ele salva uma cópia no `localStorage` do navegador e pode sincronizar tudo com Google Sheets usando Google Apps Script.

## Modo online com Google Sheets

O app já está configurado para sincronizar com esta URL do Google Apps Script:

`https://script.google.com/macros/s/AKfycbyW4OSUps3QD51_HZVsZiV8vSlyH0pCl4WiPtD7ihN3jYOH2TYo3nrfEl02HFnSvU8uAA/exec`

Para a sincronização funcionar, o projeto do Google Apps Script dessa URL precisa estar com o código do arquivo `google-apps-script.gs`.

### Como configurar a planilha

1. Abra sua planilha no Google Sheets.
2. Vá em **Extensões > Apps Script**.
3. Apague o código antigo do arquivo `Code.gs`.
4. Cole todo o conteúdo do arquivo `google-apps-script.gs`.
5. Clique em **Salvar**.
6. Vá em **Implantar > Gerenciar implantações**.
7. Edite a implantação do Web App.
8. Use estas opções:
   - Executar como: **Eu**.
   - Quem pode acessar: **Qualquer pessoa**.
9. Clique em **Implantar**.
10. Se o Google pedir autorização, autorize o acesso à planilha.

Depois disso, o app salva automaticamente nas abas:

- `SlotGain_Estado`: backup completo do app.
- `SlotGain_Slots`: espelho dos slots em formato de planilha.
- `SlotGain_Historico`: histórico das ações.

O app também continua salvando uma cópia no navegador. Se a internet falhar, ele preserva os dados locais e tenta sincronizar novamente quando você usar o botão **Sincronizar agora**.

## Como usar

1. Abra o arquivo `index.html` no navegador.
2. Os slots iniciais já são criados automaticamente:
   - BTC 1%: 25 slots com base de 10 USDT.
   - SOL 5%: 10 slots com base de 25 USDT.
3. A tela de slots aparece em formato de lista compacta.
4. Cada linha mostra estratégia, número do slot, status, gains, valor atual, última atualização e ações rápidas.
5. Use os botões pequenos de cada linha:
   - Abrir: marca o slot como Aberto e ele sobe para o topo da lista.
   - +Gain: soma um gain, recalcula o valor e muda o slot para Gain/Disponível.
   - Hold: marca o slot como Preso/Hold.
   - Zerar: limpa status, gains e observações depois de confirmação.
   - Editar: ajusta status, gains e observações manualmente.

## Lista compacta

A lista é ordenada automaticamente nesta ordem:

1. Slots Abertos.
2. Slots Presos/Hold.
3. Slots com Gain/Disponíveis.
4. Slots Zerados.

Dentro de cada grupo, o app mostra primeiro o menor valor atual. Em caso de empate, aparece primeiro o menor número de slot.

No celular, a mesma lista vira uma visualização vertical compacta para facilitar o toque nos botões.

## Dashboard

O topo mostra apenas:

- Total atualizado.
- Lucro acumulado.
- Total de gains.
- Slots abertos.
- Slots hold.

## Filtros

Você pode filtrar por estratégia, por status e também buscar por texto ou número do slot.

## Regras configuradas

### BTC 1%

- Nome exibido: BTC 1% | Novo Slot 2%
- 25 slots iniciais.
- Valor base por slot: 10 USDT.
- Fórmula: `10 x (1,01 ^ quantidade_de_gains)`.
- Novo slot a cada queda de 2%.
- Se houver slots zerados, sugere o próximo zerado.
- Se todos os 25 slots iniciais já foram usados e não houver slot aberto, sugere 5 slots de menor valor atual.

### SOL 5%

- Nome exibido: SOL 5% | Novo Slot 12%
- 10 slots iniciais.
- Valor base por slot: 25 USDT.
- Fórmula: `25 x (1,05 ^ quantidade_de_gains)`.
- Novo slot a cada queda de 12%.
- Se houver slots zerados, sugere o próximo zerado.
- Se todos os 10 slots iniciais já foram usados e não houver slot aberto, sugere 3 slots de menor valor atual.

## Histórico

O histórico de ações fica recolhido por padrão. Abra a seção no fim da tela para ver aberturas, gains, holds, edições, importações e resets.

## Backup

Mesmo com Google Sheets, é recomendado clicar em **Backup JSON** de vez em quando para baixar um arquivo com todos os slots, histórico, edições e observações.

## Restaurar backup

Clique em **Importar JSON**, escolha um backup exportado pelo app e confirme a substituição dos dados atuais do navegador.

## Exportar CSV

Clique em **CSV** para baixar uma planilha com estratégia, número do slot, status, gains, valor base, valor atual, última atualização e observações.

## Hospedar no GitHub Pages

1. Crie um repositório no GitHub.
2. Envie os arquivos `index.html`, `style.css`, `script.js` e `README.md` para a branch principal.
3. No GitHub, abra **Settings > Pages**.
4. Em **Build and deployment**, escolha **Deploy from a branch**.
5. Selecione a branch principal e a pasta `/root`.
6. Salve. O GitHub mostrará a URL pública do app.

## Usar no iPhone

Abra a URL do app no Safari, toque em compartilhar e escolha **Adicionar à Tela de Início**. O app continuará usando o armazenamento local desse navegador, então mantenha backups JSON periódicos.
