const SPREADSHEET_ID = "";
const STATE_SHEET = "SlotGain_Estado";
const SLOTS_SHEET = "SlotGain_Slots";
const HISTORY_SHEET = "SlotGain_Historico";
const STATE_CHUNK_SIZE = 40000;

function doGet(e) {
  const action = String((e && e.parameter && e.parameter.action) || "load").toLowerCase();
  return handleRequest_(action, {});
}

function doPost(e) {
  const payload = parsePayload_(e);
  const action = String(payload.action || "save").toLowerCase();
  return handleRequest_(action, payload);
}

function handleRequest_(action, payload) {
  try {
    if (action === "ping") {
      return json_({ ok: true, app: "SlotGain Control", checkedAt: new Date().toISOString() });
    }

    if (action === "load") {
      return json_({ ok: true, state: loadState_(), loadedAt: new Date().toISOString() });
    }

    if (action === "save") {
      if (!payload.state || !Array.isArray(payload.state.slots)) {
        throw new Error("Estado invalido: slots ausentes.");
      }

      saveState_(payload.state);
      return json_({ ok: true, savedAt: new Date().toISOString() });
    }

    return json_({ ok: false, error: "Acao invalida." });
  } catch (error) {
    return json_({ ok: false, error: String(error && error.message ? error.message : error) });
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
