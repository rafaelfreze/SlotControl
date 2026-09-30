# Tela inicial compacta — 30/09/2026

Mudança exclusivamente de apresentação. Não altera admissão, histerese,
headroom, coleta, cron, Watchdog server-side, motores, ordens ou credenciais.

## Todos

- Um card à esquerda, alinhado em largura/altura aos cards de mercado e
  monitoramento no desktop. Detalhes abrem sobre a tela, sem expandir a grade.
- Até cinco executores: falhas/telemetria ausente ou vencida primeiro;
  depois executores com +1 autorizado pelo gate persistido. Se nenhum
  saudável tiver espaço, todos são candidatos ao resumo limitado a cinco.
- O resumo informa quando não contém todos os executores. A observação
  completa continua alimentando a sincronização; não é truncada na coleta.
- Nome/estado do executor usam 13 px, proporcionais ao monitoramento lateral.
  A linha inteira abre os detalhes por clique, toque ou Enter/Espaço,
  com foco visível e estado expandido acessível. Fechar/Esc retorna à tela
  e ao foco anterior. Watchdog usa o mesmo painel sobreposto, com rolagem
  interna e sem alterar altura/largura dos cards. Controles dos detalhes
  permanecem separados desse botão; abrir detalhes não salva preferências.
- Contas em blocos de moeda nativa, sem truncar nomes/valores. Nome, estado,
  motores ativos, ganhos, alertas, exposição e P&L permanecem disponíveis.
  Primeiro lote de 30, com mais 30 sob demanda, inclusive ao voltar a Todos.
- Até dez colunas no desktop largo; oito/seis/quatro em larguras menores.
  Mobile estreito usa duas para legibilidade; mobile largo usa até quatro.
- Os cinco indicadores detalhados (saldo livre, capital em posições, P&L,
  exposição e limites) não aparecem em Todos. A consulta de saldos livres
  também só ocorre ao selecionar uma conta; os blocos compactos continuam
  apresentando exposição e P&L do ledger, sem novas consultas Binance.

## Conta selecionada

Os cinco indicadores financeiros permanecem disponíveis com seu escopo
e moeda originais, inclusive ao filtrar um mercado.

Executores sem atenção, Watchdog HEALTHY e resumo operacional saudável
ficam ocultos, com os componentes de observação ainda montados. Saldo e
operações ficam mais acima. Falhas, telemetria insuficiente/vencida e
Watchdog indisponível permanecem visíveis; falha de estratégia/conectividade
também mantém o resumo operacional. Carregamento não é tratado como falha.

## Validação

Testes unitários de seleção/freshness e contrato do gate; lint direcionado,
typecheck e build. Fixtures Playwright isoladas validam 320–1920 px, limite
de cinco com falha primeiro, fallback sem espaço, contas em lotes de 30,
ausência de overflow, alinhamento e detalhes. Conta saudável/falha são
cenários distintos; nenhuma ação server-side/exchange é executada.
