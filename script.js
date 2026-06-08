"use strict";

const STORAGE_KEY = "slotgain-control-state-v1";
const MAX_HISTORY = 220;
const CLOUD_ENDPOINT =
  "https://script.google.com/macros/s/AKfycbyW4OSUps3QD51_HZVsZiV8vSlyH0pCl4WiPtD7ihN3jYOH2TYo3nrfEl02HFnSvU8uAA/exec";
const CLOUD_SAVE_DEBOUNCE_MS = 900;

const STRATEGIES = {
  btc: {
    id: "btc",
    title: "BTC 1%",
    displayName: "BTC 1% | Novo Slot 2%",
    asset: "BTC",
    baseValue: 10,
    gainRate: 0.01,
    initialSlots: 25,
    dropPercent: 2,
    restartAmount: 5,
  },
  sol: {
    id: "sol",
    title: "SOL 5%",
    displayName: "SOL 5% | Novo Slot 12%",
    asset: "SOL",
    baseValue: 25,
    gainRate: 0.05,
    initialSlots: 10,
    dropPercent: 12,
    restartAmount: 3,
  },
};

const STATUS = {
  zerado: { label: "Zerado", className: "status-zerado" },
  aberto: { label: "Aberto", className: "status-aberto" },
  gain: { label: "Gain/Disponível", className: "status-gain" },
  hold: { label: "Preso/Hold", className: "status-hold" },
};

const STATUS_ORDER = {
  aberto: 0,
  hold: 1,
  gain: 2,
  zerado: 3,
};

const stateRefs = {};
let hasStoredState = false;
let state = loadState();
let toastTimer = null;
let cloudSyncTimer = null;
let cloudSaving = false;
let cloudPendingSave = false;

document.addEventListener("DOMContentLoaded", () => {
  bindElements();
  bindEvents();
  if (hasStoredState) {
    persistState({ touch: false, sync: false });
  }
  render();
  initializeCloudSync();
});

function bindElements() {
  stateRefs.totalUpdated = document.querySelector("#total-updated");
  stateRefs.estimatedProfit = document.querySelector("#estimated-profit");
  stateRefs.totalGains = document.querySelector("#total-gains");
  stateRefs.openSlots = document.querySelector("#open-slots");
  stateRefs.holdSlots = document.querySelector("#hold-slots");
  stateRefs.suggestionsGrid = document.querySelector("#suggestions-grid");
  stateRefs.strategyFilter = document.querySelector("#strategy-filter");
  stateRefs.statusFilter = document.querySelector("#status-filter");
  stateRefs.slotSearch = document.querySelector("#slot-search");
  stateRefs.addSlotForm = document.querySelector("#add-slot-form");
  stateRefs.addStrategy = document.querySelector("#add-strategy");
  stateRefs.addQuantity = document.querySelector("#add-quantity");
  stateRefs.slotsContainer = document.querySelector("#slots-container");
  stateRefs.slotCount = document.querySelector("#slot-count");
  stateRefs.historyList = document.querySelector("#history-list");
  stateRefs.historyCount = document.querySelector("#history-count");
  stateRefs.lastSaved = document.querySelector("#last-saved");
  stateRefs.cloudStatus = document.querySelector("#cloud-status");
  stateRefs.syncCloud = document.querySelector("#sync-cloud");
  stateRefs.exportJson = document.querySelector("#export-json");
  stateRefs.importJson = document.querySelector("#import-json");
  stateRefs.importFile = document.querySelector("#import-file");
  stateRefs.exportCsv = document.querySelector("#export-csv");
  stateRefs.resetAll = document.querySelector("#reset-all");
  stateRefs.editDialog = document.querySelector("#edit-dialog");
  stateRefs.editForm = document.querySelector("#edit-form");
  stateRefs.editSlotId = document.querySelector("#edit-slot-id");
  stateRefs.editTitle = document.querySelector("#edit-title");
  stateRefs.editStatus = document.querySelector("#edit-status");
  stateRefs.editGains = document.querySelector("#edit-gains");
  stateRefs.editNotes = document.querySelector("#edit-notes");
  stateRefs.closeEdit = document.querySelector("#close-edit");
  stateRefs.cancelEdit = document.querySelector("#cancel-edit");
  stateRefs.toast = document.querySelector("#toast");
}

function bindEvents() {
  stateRefs.strategyFilter.addEventListener("change", renderSlots);
  stateRefs.statusFilter.addEventListener("change", renderSlots);
  stateRefs.slotSearch.addEventListener("input", renderSlots);
  stateRefs.addSlotForm.addEventListener("submit", handleAddSlots);
  stateRefs.slotsContainer.addEventListener("click", handleSlotAction);
  stateRefs.suggestionsGrid.addEventListener("click", handleSuggestionAction);
  stateRefs.exportJson.addEventListener("click", exportJsonBackup);
  stateRefs.syncCloud.addEventListener("click", () => reconcileCloudState({ manual: true }));
  stateRefs.importJson.addEventListener("click", () => stateRefs.importFile.click());
  stateRefs.importFile.addEventListener("change", importJsonBackup);
  stateRefs.exportCsv.addEventListener("click", exportCsv);
  stateRefs.resetAll.addEventListener("click", resetAllData);
  stateRefs.editForm.addEventListener("submit", saveManualEdit);
  stateRefs.closeEdit.addEventListener("click", closeEditDialog);
  stateRefs.cancelEdit.addEventListener("click", closeEditDialog);
  stateRefs.editDialog.addEventListener("click", (event) => {
    const rect = stateRefs.editDialog.getBoundingClientRect();
    const outside =
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom;

    if (outside) {
      closeEditDialog();
    }
  });
}

function createDefaultState() {
  const createdAt = nowIso();
  const slots = Object.values(STRATEGIES).flatMap((strategy) =>
    Array.from({ length: strategy.initialSlots }, (_, index) =>
      createSlot(strategy.id, index + 1, createdAt, `slot-${strategy.id}-${index + 1}`)
    )
  );

  return {
    version: 1,
    createdAt,
    updatedAt: createdAt,
    slots,
    history: [
      {
        id: uniqueId("history"),
        date: createdAt,
        action: "Sistema",
        detail: "Estratégias iniciais criadas: 25 slots BTC e 10 slots SOL.",
        strategyId: null,
        slotNumber: null,
      },
    ],
  };
}

function createSlot(strategyId, number, createdAt = nowIso(), id = uniqueId("slot")) {
  const strategy = STRATEGIES[strategyId];

  return {
    id,
    strategyId,
    number,
    status: "zerado",
    gains: 0,
    baseValue: strategy.baseValue,
    gainRate: strategy.gainRate,
    startedOnce: false,
    createdAt,
    updatedAt: null,
    notes: "",
  };
}

function loadState() {
  try {
    const rawState = localStorage.getItem(STORAGE_KEY);
    if (!rawState) {
      return createDefaultState();
    }

    hasStoredState = true;
    return normalizeState(JSON.parse(rawState));
  } catch (error) {
    console.warn("Não foi possível carregar os dados locais.", error);
    return createDefaultState();
  }
}

function normalizeState(input) {
  if (!input || !Array.isArray(input.slots)) {
    return createDefaultState();
  }

  const fallbackDate = nowIso();
  const normalizedSlots = input.slots
    .filter((slot) => slot && STRATEGIES[slot.strategyId])
    .map((slot, index) => {
      const strategy = STRATEGIES[slot.strategyId];
      const status = STATUS[slot.status] ? slot.status : "zerado";
      const gains = Math.max(0, Number.parseInt(slot.gains, 10) || 0);
      const number = Math.max(1, Number.parseInt(slot.number, 10) || index + 1);
      const isZero = status === "zerado";

      return {
        id: String(slot.id || uniqueId("slot")),
        strategyId: slot.strategyId,
        number,
        status,
        gains: isZero ? 0 : gains,
        baseValue: Number(slot.baseValue) > 0 ? Number(slot.baseValue) : strategy.baseValue,
        gainRate: Number(slot.gainRate) >= 0 ? Number(slot.gainRate) : strategy.gainRate,
        startedOnce: isZero ? false : Boolean(slot.startedOnce || gains > 0 || status !== "zerado"),
        createdAt: slot.createdAt || fallbackDate,
        updatedAt: slot.updatedAt || null,
        notes: String(slot.notes || ""),
      };
    });

  if (normalizedSlots.length === 0) {
    return createDefaultState();
  }

  const normalizedHistory = Array.isArray(input.history)
    ? input.history.slice(0, MAX_HISTORY).map((item) => ({
        id: String(item.id || uniqueId("history")),
        date: item.date || fallbackDate,
        action: String(item.action || "Registro"),
        detail: String(item.detail || ""),
        strategyId: item.strategyId || null,
        slotNumber: item.slotNumber || null,
      }))
    : [];

  return {
    version: 1,
    createdAt: input.createdAt || fallbackDate,
    updatedAt: input.updatedAt || fallbackDate,
    slots: normalizedSlots,
    history: normalizedHistory,
  };
}

function persistState(options = {}) {
  const { touch = true, sync = true } = options;
  if (touch) {
    state.updatedAt = nowIso();
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    hasStoredState = true;
  } catch (error) {
    console.warn("Não foi possível salvar no localStorage.", error);
    showToast("Não foi possível salvar no navegador.");
  }

  if (sync) {
    scheduleCloudSave();
  }
}

function render() {
  renderDashboard();
  renderSuggestions();
  renderSlots();
  renderHistory();
  renderLastSaved();
}

function renderDashboard() {
  const totals = state.slots.reduce(
    (acc, slot) => {
      acc.base += slot.baseValue;
      acc.updated += getCurrentValue(slot);
      acc.gains += slot.gains;
      acc.open += slot.status === "aberto" ? 1 : 0;
      acc.hold += slot.status === "hold" ? 1 : 0;
      return acc;
    },
    { base: 0, updated: 0, gains: 0, open: 0, hold: 0 }
  );

  stateRefs.totalUpdated.textContent = formatUsdt(totals.updated);
  stateRefs.estimatedProfit.textContent = formatUsdt(totals.updated - totals.base);
  stateRefs.totalGains.textContent = String(totals.gains);
  stateRefs.openSlots.textContent = String(totals.open);
  stateRefs.holdSlots.textContent = String(totals.hold);
}

function renderSuggestions() {
  if (hasOpenSlot()) {
    stateRefs.suggestionsGrid.innerHTML = `
      <article class="suggestion-card alert">
        <div>
          <p class="eyebrow">Ciclo automático</p>
          <h3>Aguardando finalização</h3>
          <p>Existem slots em aberto, aguarde finalizar antes de reiniciar ciclo automático.</p>
        </div>
      </article>
    `;
    return;
  }

  stateRefs.suggestionsGrid.innerHTML = Object.keys(STRATEGIES)
    .map((strategyId) => {
      const suggestion = getStrategySuggestion(strategyId);
      const disabled = suggestion.slots.length === 0 ? "disabled" : "";

      return `
        <article class="suggestion-card">
          <div>
            <p class="eyebrow">${escapeHtml(STRATEGIES[strategyId].displayName)}</p>
            <h3>${escapeHtml(suggestion.title)}</h3>
            <p>${escapeHtml(suggestion.text)}</p>
          </div>
          <button class="secondary-button" type="button" data-action="apply-suggestion" data-strategy="${strategyId}" ${disabled}>
            Aplicar sugestão
          </button>
        </article>
      `;
    })
    .join("");
}

function renderSlots() {
  const filter = stateRefs.strategyFilter.value;
  const statusFilter = stateRefs.statusFilter.value;
  const search = normalizeSearch(stateRefs.slotSearch.value);
  const filteredSlots = getSortedSlots().filter((slot) => {
    if (filter !== "all" && slot.strategyId !== filter) {
      return false;
    }

    if (statusFilter !== "all" && slot.status !== statusFilter) {
      return false;
    }

    if (!search) {
      return true;
    }

    const strategy = STRATEGIES[slot.strategyId];
    const haystack = normalizeSearch(
      [
        strategy.title,
        strategy.displayName,
        strategy.asset,
        `slot ${slot.number}`,
        String(slot.number),
        STATUS[slot.status].label,
        slot.status,
        slot.notes,
      ].join(" ")
    );

    return haystack.includes(search);
  });

  stateRefs.slotCount.textContent = `${filteredSlots.length} visíveis`;

  if (filteredSlots.length === 0) {
    stateRefs.slotsContainer.innerHTML = `<div class="empty-state">Nenhum slot encontrado.</div>`;
    return;
  }

  stateRefs.slotsContainer.innerHTML = `
    <div class="slot-row header" role="row">
      <div>Estratégia</div>
      <div>Slot</div>
      <div>Status</div>
      <div>Gains</div>
      <div>Valor atual</div>
      <div>Atualização</div>
      <div>Ações</div>
    </div>
    ${filteredSlots.map(renderSlotRow).join("")}
  `;
}

function renderSlotRow(slot) {
  const strategy = STRATEGIES[slot.strategyId];
  const status = STATUS[slot.status];
  const currentValue = getCurrentValue(slot);
  const openDisabled = slot.status === "aberto" || slot.status === "hold";
  const gainDisabled = slot.status === "zerado";
  const holdDisabled = slot.status === "zerado" || slot.status === "hold";
  const updatedAt = slot.updatedAt ? formatDate(slot.updatedAt) : "Nunca";

  return `
    <div class="slot-row ${status.className}" role="row">
      <div class="slot-cell strategy" data-label="Estratégia">${escapeHtml(strategy.title)}</div>
      <div class="slot-cell number" data-label="Slot">#${slot.number}</div>
      <div class="slot-cell status" data-label="Status">
        <span class="status-pill ${status.className}">${escapeHtml(status.label)}</span>
      </div>
      <div class="slot-cell gains" data-label="Gains">${slot.gains}</div>
      <div class="slot-cell value" data-label="Valor">${formatUsdt(currentValue)}</div>
      <div class="slot-cell updated" data-label="Atualização">${updatedAt}</div>
      <div class="slot-cell actions" data-label="Ações">
        <div class="slot-actions">
          <button class="slot-button open" type="button" data-action="open" data-id="${escapeAttribute(slot.id)}" ${openDisabled ? "disabled" : ""}>Abrir</button>
          <button class="slot-button gain" type="button" data-action="gain" data-id="${escapeAttribute(slot.id)}" ${gainDisabled ? "disabled" : ""}>+Gain</button>
          <button class="slot-button hold" type="button" data-action="hold" data-id="${escapeAttribute(slot.id)}" ${holdDisabled ? "disabled" : ""}>Hold</button>
          <button class="slot-button reset" type="button" data-action="reset" data-id="${escapeAttribute(slot.id)}">Zerar</button>
          <button class="slot-button edit" type="button" data-action="edit" data-id="${escapeAttribute(slot.id)}">Editar</button>
        </div>
      </div>
    </div>
  `;
}

function renderHistory() {
  stateRefs.historyCount.textContent = `${state.history.length} ações`;

  if (state.history.length === 0) {
    stateRefs.historyList.innerHTML = `<li class="empty-state">Sem histórico ainda.</li>`;
    return;
  }

  stateRefs.historyList.innerHTML = state.history
    .slice(0, 60)
    .map((item) => {
      const strategy = item.strategyId ? STRATEGIES[item.strategyId]?.title : "Geral";
      const slotText = item.slotNumber ? `Slot #${item.slotNumber}` : "Sistema";

      return `
        <li class="history-item">
          <strong>${escapeHtml(item.action)} · ${escapeHtml(strategy || "Geral")} · ${escapeHtml(slotText)}</strong>
          <span>${escapeHtml(formatDate(item.date))}</span>
          <span>${escapeHtml(item.detail)}</span>
        </li>
      `;
    })
    .join("");
}

function renderLastSaved() {
  stateRefs.lastSaved.textContent = `Salvo neste navegador em ${formatDate(state.updatedAt)}.`;
}

async function initializeCloudSync() {
  if (!isCloudEnabled()) {
    setCloudStatus("Modo local ativo. Sincronização online pausada.", "error");
    return;
  }

  await reconcileCloudState({ manual: false });
}

async function reconcileCloudState({ manual = false } = {}) {
  if (!isCloudEnabled()) {
    setCloudStatus("Modo local ativo. Sincronização online pausada.", "error");
    return;
  }

  setCloudStatus("Conectando com a planilha...", "saving");

  try {
    const response = await cloudRequest("load");
    const remoteState = extractCloudState(response);

    if (remoteState) {
      const remoteTime = getStateTime(remoteState);
      const localTime = getStateTime(state);
      const shouldUseRemote = !hasStoredState || remoteTime > localTime;

      if (shouldUseRemote) {
        state = remoteState;
        persistState({ touch: false, sync: false });
        render();
        setCloudStatus(`Planilha carregada em ${formatDate(state.updatedAt)}.`, "ok");
        if (manual) {
          showToast("Dados carregados da planilha.");
        }
        return;
      }
    }

    if (!hasStoredState) {
      persistState({ touch: false, sync: false });
    }
    await saveStateToCloud();
    if (manual) {
      showToast("Planilha sincronizada.");
    }
  } catch (error) {
    console.warn("Falha na sincronização com Google Sheets.", error);
    if (!hasStoredState) {
      persistState({ touch: false, sync: false });
    }
    setCloudStatus("Sem conexão com a planilha. Dados salvos neste navegador.", "error");
    if (manual) {
      showToast("Não foi possível sincronizar com a planilha.");
    }
  }
}

function scheduleCloudSave() {
  if (!isCloudEnabled()) {
    return;
  }

  window.clearTimeout(cloudSyncTimer);
  setCloudStatus("Alteração local salva. Enviando para a planilha...", "saving");
  cloudSyncTimer = window.setTimeout(() => {
    saveStateToCloud();
  }, CLOUD_SAVE_DEBOUNCE_MS);
}

async function saveStateToCloud() {
  if (!isCloudEnabled()) {
    return;
  }

  if (cloudSaving) {
    cloudPendingSave = true;
    return;
  }

  cloudSaving = true;
  cloudPendingSave = false;
  setCloudStatus("Salvando na planilha...", "saving");
  setCloudButtonDisabled(true);

  try {
    await cloudRequest("save", { state });
    setCloudStatus(`Online salvo em ${formatDate(nowIso())}.`, "ok");
  } catch (error) {
    console.warn("Falha ao salvar no Google Sheets.", error);
    setCloudStatus("Falha ao salvar online. Cópia local preservada.", "error");
  } finally {
    cloudSaving = false;
    setCloudButtonDisabled(false);

    if (cloudPendingSave) {
      cloudPendingSave = false;
      scheduleCloudSave();
    }
  }
}

async function cloudRequest(action, payload = {}) {
  if (!isCloudEnabled()) {
    throw new Error("Sincronização online pausada.");
  }

  const response = await fetch(CLOUD_ENDPOINT, {
    method: "POST",
    mode: "cors",
    redirect: "follow",
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
    },
    body: JSON.stringify({
      app: "SlotGain Control",
      action,
      ...payload,
    }),
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error("Resposta inválida do Google Apps Script.");
  }

  if (!response.ok || data.ok === false) {
    throw new Error(data.error || "Erro ao comunicar com Google Sheets.");
  }

  return data;
}

function isCloudEnabled() {
  return Boolean(CLOUD_ENDPOINT) && !new URLSearchParams(window.location.search).has("offline");
}

function extractCloudState(response) {
  const candidate = response?.state || response?.data || null;
  if (!candidate || !Array.isArray(candidate.slots)) {
    return null;
  }

  return normalizeState(candidate);
}

function getStateTime(candidate) {
  const value = candidate?.updatedAt || candidate?.createdAt;
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function setCloudStatus(message, type = "idle") {
  if (!stateRefs.cloudStatus) {
    return;
  }

  stateRefs.cloudStatus.textContent = message;
  stateRefs.cloudStatus.classList.remove("is-ok", "is-saving", "is-error");

  if (type === "ok") {
    stateRefs.cloudStatus.classList.add("is-ok");
  }

  if (type === "saving") {
    stateRefs.cloudStatus.classList.add("is-saving");
  }

  if (type === "error") {
    stateRefs.cloudStatus.classList.add("is-error");
  }
}

function setCloudButtonDisabled(disabled) {
  if (stateRefs.syncCloud) {
    stateRefs.syncCloud.disabled = disabled;
  }
}

function handleSlotAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const slot = findSlot(button.dataset.id);
  if (!slot) {
    return;
  }

  const action = button.dataset.action;
  if (action === "open") {
    openSlot(slot);
  }

  if (action === "gain") {
    registerGain(slot);
  }

  if (action === "hold") {
    markHold(slot);
  }

  if (action === "reset") {
    resetSlot(slot);
  }

  if (action === "edit") {
    openEditDialog(slot);
  }
}

function handleSuggestionAction(event) {
  const button = event.target.closest("button[data-action='apply-suggestion']");
  if (!button) {
    return;
  }

  applySuggestion(button.dataset.strategy);
}

function openSlot(slot) {
  if (slot.status === "aberto" || slot.status === "hold") {
    showToast("Este slot não está disponível para abertura.");
    return;
  }

  slot.status = "aberto";
  slot.startedOnce = true;
  slot.updatedAt = nowIso();
  addHistory("Abertura", `Slot aberto com valor calculado de ${formatUsdt(getCurrentValue(slot))}.`, slot);
  persistState();
  render();
  showToast("Slot aberto.");
}

function registerGain(slot) {
  if (slot.status === "zerado") {
    showToast("Abra o slot antes de registrar gain.");
    return;
  }

  slot.gains += 1;
  slot.status = "gain";
  slot.startedOnce = true;
  slot.updatedAt = nowIso();
  addHistory("Gain", `Gain registrado. Novo valor: ${formatUsdt(getCurrentValue(slot))}.`, slot);
  persistState();
  render();
  showToast("Gain registrado e slot disponível.");
}

function markHold(slot) {
  if (slot.status === "zerado") {
    showToast("Slot zerado não pode ser marcado como hold.");
    return;
  }

  slot.status = "hold";
  slot.startedOnce = true;
  slot.updatedAt = nowIso();
  addHistory("Hold", "Slot marcado como preso/hold.", slot);
  persistState();
  render();
  showToast("Slot marcado como hold.");
}

function resetSlot(slot) {
  const confirmed = window.confirm(
    `Zerar o ${STRATEGIES[slot.strategyId].title} Slot #${slot.number}? Gains, status e observações serão apagados.`
  );

  if (!confirmed) {
    return;
  }

  slot.status = "zerado";
  slot.gains = 0;
  slot.startedOnce = false;
  slot.updatedAt = nowIso();
  slot.notes = "";
  addHistory("Reset", "Slot zerado manualmente.", slot);
  persistState();
  render();
  showToast("Slot zerado.");
}

function openEditDialog(slot) {
  stateRefs.editSlotId.value = slot.id;
  stateRefs.editTitle.textContent = `${STRATEGIES[slot.strategyId].title} · Slot #${slot.number}`;
  stateRefs.editStatus.value = slot.status;
  stateRefs.editGains.value = String(slot.gains);
  stateRefs.editNotes.value = slot.notes || "";
  stateRefs.editDialog.showModal();
}

function closeEditDialog() {
  if (stateRefs.editDialog.open) {
    stateRefs.editDialog.close();
  }
}

function saveManualEdit(event) {
  event.preventDefault();

  const slot = findSlot(stateRefs.editSlotId.value);
  if (!slot) {
    return;
  }

  const nextStatus = stateRefs.editStatus.value;
  let nextGains = Math.max(0, Number.parseInt(stateRefs.editGains.value, 10) || 0);
  const nextNotes = stateRefs.editNotes.value.trim();

  if (nextStatus === "zerado") {
    const willErase = slot.status !== "zerado" || slot.gains > 0 || slot.notes;
    if (willErase && !window.confirm("Salvar como Zerado vai apagar gains e observações deste slot.")) {
      return;
    }

    nextGains = 0;
  }

  const previous = `${STATUS[slot.status].label}, ${slot.gains} gains`;
  slot.status = nextStatus;
  slot.gains = nextGains;
  slot.notes = nextStatus === "zerado" ? "" : nextNotes;
  slot.startedOnce = nextStatus !== "zerado";
  slot.updatedAt = nowIso();

  addHistory("Edição", `Antes: ${previous}. Agora: ${STATUS[slot.status].label}, ${slot.gains} gains.`, slot);
  persistState();
  render();
  closeEditDialog();
  showToast("Edição salva.");
}

function handleAddSlots(event) {
  event.preventDefault();

  const strategyId = stateRefs.addStrategy.value;
  const quantity = Math.min(50, Math.max(1, Number.parseInt(stateRefs.addQuantity.value, 10) || 1));
  const createdAt = nowIso();
  const nextNumber = getNextSlotNumber(strategyId);

  for (let index = 0; index < quantity; index += 1) {
    state.slots.push(createSlot(strategyId, nextNumber + index, createdAt));
  }

  addHistory(
    "Criação de slots",
    `${quantity} slot${quantity > 1 ? "s" : ""} adicionado${quantity > 1 ? "s" : ""} em ${STRATEGIES[strategyId].title}.`,
    { strategyId, number: null }
  );
  stateRefs.addQuantity.value = "1";
  persistState();
  render();
  showToast("Slots adicionados.");
}

function applySuggestion(strategyId) {
  if (hasOpenSlot()) {
    showToast("Existem slots em aberto, aguarde finalizar antes de reiniciar ciclo automático.");
    return;
  }

  const suggestion = getStrategySuggestion(strategyId);
  if (suggestion.slots.length === 0) {
    showToast("Nenhum slot disponível para sugestão.");
    return;
  }

  suggestion.slots.forEach((slot) => {
    slot.status = "aberto";
    slot.startedOnce = true;
    slot.updatedAt = nowIso();
    addHistory("Sugestão automática", `Slot iniciado pela regra: ${suggestion.title}.`, slot);
  });

  persistState();
  render();
  showToast("Sugestão aplicada.");
}

function resetAllData() {
  const confirmed = window.confirm(
    "Resetar todos os dados do SlotGain Control? Esta ação apaga slots, histórico e edições salvas neste navegador."
  );

  if (!confirmed) {
    return;
  }

  state = createDefaultState();
  addHistory("Reset geral", "Todos os dados foram recriados com as estratégias iniciais.", {
    strategyId: null,
    number: null,
  });
  persistState();
  render();
  showToast("Dados resetados.");
}

function exportJsonBackup() {
  const backup = {
    app: "SlotGain Control",
    exportedAt: nowIso(),
    ...state,
  };

  downloadText(JSON.stringify(backup, null, 2), `slotgain-backup-${fileDate()}.json`, "application/json");
  showToast("Backup JSON exportado.");
}

function importJsonBackup(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = normalizeImportedState(JSON.parse(String(reader.result)));
      const confirmed = window.confirm(
        "Importar este backup vai substituir os dados atuais salvos neste navegador."
      );

      if (!confirmed) {
        return;
      }

      state = imported;
      addHistory("Importação", `Backup restaurado a partir do arquivo ${file.name}.`, {
        strategyId: null,
        number: null,
      });
      persistState();
      render();
      showToast("Backup restaurado.");
    } catch (error) {
      console.warn(error);
      window.alert("Não foi possível importar este JSON. Verifique se é um backup válido do SlotGain Control.");
    } finally {
      stateRefs.importFile.value = "";
    }
  };

  reader.readAsText(file);
}

function normalizeImportedState(input) {
  if (!input || !Array.isArray(input.slots)) {
    throw new Error("Backup inválido.");
  }

  const normalized = normalizeState(input);
  if (!normalized.slots.length) {
    throw new Error("Backup sem slots válidos.");
  }

  return normalized;
}

function exportCsv() {
  const headers = [
    "estrategia",
    "slot",
    "status",
    "gains",
    "valor_base_usdt",
    "valor_atual_usdt",
    "ultima_atualizacao",
    "observacoes",
  ];

  const rows = getSortedSlots().map((slot) => [
    STRATEGIES[slot.strategyId].title,
    slot.number,
    STATUS[slot.status].label,
    slot.gains,
    slot.baseValue.toFixed(2),
    getCurrentValue(slot).toFixed(2),
    slot.updatedAt ? formatDate(slot.updatedAt) : "",
    slot.notes || "",
  ]);

  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
  downloadText(csv, `slotgain-slots-${fileDate()}.csv`, "text/csv;charset=utf-8");
  showToast("CSV exportado.");
}

function addHistory(action, detail, slotLike) {
  state.history.unshift({
    id: uniqueId("history"),
    date: nowIso(),
    action,
    detail,
    strategyId: slotLike?.strategyId || null,
    slotNumber: slotLike?.number || null,
  });
  state.history = state.history.slice(0, MAX_HISTORY);
}

function getStrategySuggestion(strategyId) {
  const strategy = STRATEGIES[strategyId];
  const slots = getSortedSlots().filter((slot) => slot.strategyId === strategyId);
  const zeroSlots = slots.filter((slot) => slot.status === "zerado");

  if (zeroSlots.length > 0) {
    const nextSlot = zeroSlots[0];
    return {
      title: "Próximo slot zerado",
      text: `${strategy.title}: iniciar Slot #${nextSlot.number} no gatilho de queda de ${strategy.dropPercent}%.`,
      slots: [nextSlot],
      type: "zero",
    };
  }

  const availableSlots = slots
    .filter((slot) => slot.status !== "aberto" && slot.status !== "hold")
    .sort((a, b) => getCurrentValue(a) - getCurrentValue(b) || a.number - b.number)
    .slice(0, strategy.restartAmount);

  if (availableSlots.length === 0) {
    return {
      title: "Sem slots disponíveis",
      text: `${strategy.title}: todos os slots elegíveis estão presos/hold.`,
      slots: [],
      type: "none",
    };
  }

  return {
    title: "Reinício do ciclo",
    text: `${strategy.title}: iniciar ${availableSlots.length} slots de menor valor: ${availableSlots
      .map((slot) => `#${slot.number}`)
      .join(", ")}.`,
    slots: availableSlots,
    type: "cycle",
  };
}

function getGlobalSuggestionText() {
  if (hasOpenSlot()) {
    return {
      alert: true,
      text: "Existem slots em aberto, aguarde finalizar antes de reiniciar ciclo automático.",
    };
  }

  const texts = Object.keys(STRATEGIES).map((strategyId) => {
    const suggestion = getStrategySuggestion(strategyId);
    const slotList = suggestion.slots.map((slot) => `#${slot.number}`).join(", ");
    return `${STRATEGIES[strategyId].title}: ${slotList || "sem slot"}`;
  });

  return {
    alert: false,
    text: texts.join(" | "),
  };
}

function getSortedSlots() {
  const strategyOrder = Object.keys(STRATEGIES);
  return [...state.slots].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      getCurrentValue(a) - getCurrentValue(b) ||
      a.number - b.number ||
      strategyOrder.indexOf(a.strategyId) - strategyOrder.indexOf(b.strategyId)
  );
}

function getNextSlotNumber(strategyId) {
  return (
    state.slots
      .filter((slot) => slot.strategyId === strategyId)
      .reduce((highest, slot) => Math.max(highest, slot.number), 0) + 1
  );
}

function getCurrentValue(slot) {
  return slot.baseValue * Math.pow(1 + slot.gainRate, slot.gains);
}

function hasOpenSlot() {
  return state.slots.some((slot) => slot.status === "aberto");
}

function findSlot(id) {
  return state.slots.find((slot) => slot.id === id);
}

function formatUsdt(value) {
  return `${new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} USDT`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Data inválida";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function nowIso() {
  return new Date().toISOString();
}

function fileDate() {
  return nowIso().replace(/[:.]/g, "-").slice(0, 16);
}

function uniqueId(prefix) {
  if (window.crypto?.randomUUID) {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function downloadText(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function showToast(message) {
  if (!stateRefs.toast) {
    return;
  }

  window.clearTimeout(toastTimer);
  stateRefs.toast.textContent = message;
  stateRefs.toast.classList.add("show");
  toastTimer = window.setTimeout(() => {
    stateRefs.toast.classList.remove("show");
  }, 2800);
}
