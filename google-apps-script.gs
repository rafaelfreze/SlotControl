const SPREADSHEET_ID = "";
const STATE_SHEET = "SlotGain_Caixeta_Estado";
const SLOTS_SHEET = "SlotGain_Caixeta_Slots";
const HISTORY_SHEET = "SlotGain_Caixeta_Historico";
const STATE_CHUNK_SIZE = 40000;
const APP_ASSET_BASE = "https://rafaelfreze.github.io/caixeta";
const APP_ASSET_VERSION = "slotgain-caixeta-v3";

function doGet(e) {
  const action = String((e && e.parameter && e.parameter.action) || "").toLowerCase();

  if (action) {
    return json_(handleData_(action, {}));
  }

  return HtmlService.createHtmlOutput(getAppHtml_())
    .setTitle("SlotGain Control")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  const payload = parsePayload_(e);
  const action = String(payload.action || "save").toLowerCase();
  return json_(handleData_(action, payload));
}

function handleClientRequest(action, payload) {
  return handleData_(String(action || "").toLowerCase(), payload || {});
}

function handleData_(action, payload) {
  try {
    if (action === "ping") {
      return { ok: true, app: "SlotGain Control", checkedAt: new Date().toISOString() };
    }

    if (action === "load") {
      return { ok: true, state: loadState_(), loadedAt: new Date().toISOString() };
    }

    if (action === "save") {
      if (!payload.state || !Array.isArray(payload.state.slots)) {
        throw new Error("Estado invalido: slots ausentes.");
      }

      saveState_(payload.state);
      return { ok: true, savedAt: new Date().toISOString() };
    }

    return { ok: false, error: "Acao invalida." };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function parsePayload_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return {};
  }

  return JSON.parse(e.postData.contents);
}

function saveState_(state) {
  const spreadsheet = getSpreadsheet_();
  const savedAt = new Date().toISOString();

  state.updatedAt = state.updatedAt || savedAt;
  saveSnapshot_(spreadsheet, state, savedAt);
  saveSlots_(spreadsheet, state.slots || []);
  saveHistory_(spreadsheet, state.history || []);
}

function loadState_() {
  const spreadsheet = getSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(STATE_SHEET);

  if (!sheet || sheet.getLastRow() < 2) {
    return null;
  }

  const chunks = sheet
    .getRange(2, 3, sheet.getLastRow() - 1, 1)
    .getValues()
    .map((row) => row[0])
    .filter(Boolean);

  if (!chunks.length) {
    return null;
  }

  return JSON.parse(chunks.join(""));
}

function saveSnapshot_(spreadsheet, state, savedAt) {
  const sheet = getOrCreateSheet_(spreadsheet, STATE_SHEET);
  const json = JSON.stringify(state);
  const rows = [["savedAt", "chunkIndex", "stateJsonChunk"]];

  for (let index = 0; index < json.length; index += STATE_CHUNK_SIZE) {
    rows.push([savedAt, rows.length, json.slice(index, index + STATE_CHUNK_SIZE)]);
  }

  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.autoResizeColumns(1, 3);
}

function saveSlots_(spreadsheet, slots) {
  const sheet = getOrCreateSheet_(spreadsheet, SLOTS_SHEET);
  const rows = [
    [
      "estrategia",
      "ordem",
      "slot",
      "status",
      "gains",
      "valor_base_usdt",
      "valor_atual_usdt",
      "ultima_atualizacao",
      "observacoes",
    ],
  ];

  slots.forEach((slot) => {
    rows.push([
      slot.strategyId || "",
      Number(slot.order || 0),
      slot.number || "",
      slot.status || "",
      Number(slot.gains || 0),
      Number(slot.baseValue || 0),
      currentValue_(slot),
      slot.updatedAt || "",
      slot.notes || "",
    ]);
  });

  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.autoResizeColumns(1, rows[0].length);
}

function saveHistory_(spreadsheet, history) {
  const sheet = getOrCreateSheet_(spreadsheet, HISTORY_SHEET);
  const rows = [["data", "acao", "estrategia", "slot", "detalhe"]];

  history.forEach((item) => {
    rows.push([
      item.date || "",
      item.action || "",
      item.strategyId || "",
      item.slotNumber || "",
      item.detail || "",
    ]);
  });

  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.autoResizeColumns(1, rows[0].length);
}

function currentValue_(slot) {
  const baseValue = Number(slot.baseValue || 0);
  const gainRate = Number(slot.gainRate || 0);
  const gains = Number(slot.gains || 0);
  return baseValue * Math.pow(1 + gainRate, gains);
}

function getSpreadsheet_() {
  if (SPREADSHEET_ID) {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error("Abra o Apps Script pela planilha ou preencha SPREADSHEET_ID.");
  }

  return spreadsheet;
}

function getOrCreateSheet_(spreadsheet, name) {
  return spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function getAppHtml_() {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#070b12">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-title" content="SlotGain Control">
    <base target="_top">
    <title>SlotGain Control</title>
    <link rel="stylesheet" href="${APP_ASSET_BASE}/style.css?v=${APP_ASSET_VERSION}">
  </head>
  <body>
    <div class="app-shell">
      <header class="topbar">
        <div class="brand-block">
          <div class="brand-mark" aria-hidden="true">SG</div>
          <div>
            <p class="eyebrow">Controle cripto por slots</p>
            <h1>SlotGain Control</h1>
            <p id="last-saved" class="last-saved">Carregando dados locais...</p>
          </div>
        </div>

      </header>

      <main>
        <section class="dashboard" aria-label="Dashboard">
          <article class="metric-card">
            <span>Total atualizado</span>
            <strong id="total-updated">0 USDT</strong>
          </article>
          <article class="metric-card positive">
            <span>Lucro acumulado</span>
            <strong id="estimated-profit">0 USDT</strong>
          </article>
        </section>

        <section id="crypto-summary" class="crypto-summary" aria-label="Resumo por cripto"></section>

        <section class="content-layout">
          <section class="slots-area" aria-label="Slots">
            <div class="section-heading">
              <h2>Slots</h2>
              <div class="slots-heading-controls">
                <label for="strategy-filter">Moeda</label>
                <select id="strategy-filter">
                  <option value="all">Todas</option>
                  <option value="btc">BTC 1%</option>
                  <option value="sol">SOL 5%</option>
                </select>
                <span id="slot-count">0 visiveis</span>
              </div>
            </div>
            <div id="slot-status-filters" class="slot-status-filters" aria-label="Filtro rapido de slots">
              <button class="slot-filter-button active" type="button" data-slot-filter="all">
                Todos <strong id="filter-count-all">0</strong>
              </button>
              <button class="slot-filter-button" type="button" data-slot-filter="open">
                Abertos <strong id="filter-count-open">0</strong>
              </button>
              <button class="slot-filter-button" type="button" data-slot-filter="closed">
                Fechados <strong id="filter-count-closed">0</strong>
              </button>
            </div>
            <div id="slots-container" class="slots-list"></div>
          </section>
        </section>

        <section class="controls-panel" aria-label="Controles">
          <div class="field search-field">
            <label for="slot-search">Busca por slot</label>
            <input id="slot-search" type="search" placeholder="Ex.: BTC, 7, hold, gain" autocomplete="off">
          </div>
        </section>

        <section class="management-panel" aria-label="Ferramentas">
          <div class="management-block">
            <p class="eyebrow">Adicionar slots</p>
            <form id="add-slot-form" class="add-slot-form">
              <div class="field">
                <label for="add-strategy">Adicionar em</label>
                <select id="add-strategy">
                  <option value="btc">BTC 1%</option>
                  <option value="sol">SOL 5%</option>
                </select>
              </div>
              <div class="field compact">
                <label for="add-quantity">Slots</label>
                <input id="add-quantity" type="number" min="1" max="50" value="1" inputmode="numeric">
              </div>
              <button class="primary-button" type="submit">Adicionar slots</button>
            </form>
          </div>

          <div class="management-block">
            <p class="eyebrow">Saldo e redistribuicao</p>
            <form id="balance-form" class="tool-form">
              <div class="field">
                <label for="balance-strategy">Moeda</label>
                <select id="balance-strategy">
                  <option value="btc">BTC 1%</option>
                  <option value="sol">SOL 5%</option>
                </select>
              </div>
              <div class="field compact">
                <label for="balance-amount">USDT por slot</label>
                <input id="balance-amount" type="number" min="0.01" step="0.01" placeholder="Ex.: 5" inputmode="decimal">
              </div>
              <button class="primary-button" type="submit">Adicionar saldo</button>
            </form>

            <form id="redistribute-form" class="tool-form single-action">
              <div class="field">
                <label for="redistribute-strategy">Redistribuir gains</label>
                <select id="redistribute-strategy">
                  <option value="btc">BTC 1%</option>
                  <option value="sol">SOL 5%</option>
                </select>
              </div>
              <button class="secondary-button" type="submit">Redistribuir</button>
            </form>
          </div>

          <div class="management-block">
            <p class="eyebrow">Backup e dados</p>
            <div class="footer-actions">
              <button id="export-json" class="ghost-button" type="button">Backup JSON</button>
              <button id="import-json" class="ghost-button" type="button">Importar JSON</button>
              <button id="export-csv" class="ghost-button" type="button">CSV</button>
              <button id="reset-all" class="danger-button" type="button">Resetar tudo</button>
            </div>
          </div>
        </section>

        <details class="history-panel">
          <summary>
            <span>Historico de acoes</span>
            <strong id="history-count">0 acoes</strong>
          </summary>
          <ol id="history-list" class="history-list"></ol>
        </details>

        <section class="sync-panel" aria-label="Sincronizacao Google Sheets">
          <div>
            <span>Google Sheets</span>
            <strong id="cloud-status">Conectando com a planilha...</strong>
          </div>
          <button id="sync-cloud" class="secondary-button" type="button">Sincronizar agora</button>
        </section>
      </main>
    </div>

    <dialog id="edit-dialog" class="modal">
      <form id="edit-form" class="modal-card">
        <input id="edit-slot-id" type="hidden">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Edicao manual</p>
            <h2 id="edit-title">Slot</h2>
          </div>
          <button id="close-edit" class="icon-button" type="button" aria-label="Fechar">x</button>
        </div>

        <div class="modal-grid">
          <div class="field">
            <label for="edit-status">Status</label>
            <select id="edit-status">
              <option value="zerado">Zerado</option>
              <option value="aberto">Aberto</option>
              <option value="gain">Gain/Disponivel</option>
              <option value="hold">Preso/Hold</option>
            </select>
          </div>
          <div class="field">
            <label for="edit-gains">Quantidade de gains</label>
            <input id="edit-gains" type="number" min="0" step="1" inputmode="numeric">
          </div>
        </div>

        <div class="field">
          <label for="edit-notes">Observacoes</label>
          <textarea id="edit-notes" rows="3" placeholder="Opcional"></textarea>
        </div>

        <div class="modal-actions">
          <button class="secondary-button" type="button" id="cancel-edit">Cancelar</button>
          <button class="primary-button" type="submit">Salvar edicao</button>
        </div>
      </form>
    </dialog>

    <input id="import-file" type="file" accept="application/json" hidden>
    <div id="toast" class="toast" role="status" aria-live="polite"></div>

    <script src="${APP_ASSET_BASE}/script.js?v=${APP_ASSET_VERSION}" defer></script>
  </body>
</html>`;
}
