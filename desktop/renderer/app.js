document.body.classList.add(`platform-${window.codexAuth.platform}`);

const listEl = document.getElementById("account-list");
const emptyEl = document.getElementById("empty-state");
const summaryEl = document.getElementById("summary");
const appVersionEl = document.getElementById("app-version");
const refreshBtn = document.getElementById("refresh-btn");
const loginBtn = document.getElementById("login-btn");
const emptyLoginBtn = document.getElementById("empty-login-btn");
const loginBanner = document.getElementById("login-banner");
const loginCancelBtn = document.getElementById("login-cancel-btn");
const toastEl = document.getElementById("toast");
const addApiBtn = document.getElementById("add-api-btn");
const importBtn = document.getElementById("import-btn");
const exportBtn = document.getElementById("export-btn");
const apiFormEl = document.getElementById("api-form");
const apiBaseUrlInput = document.getElementById("api-base-url");
const apiKeyInput = document.getElementById("api-key");
const apiNameInput = document.getElementById("api-name");
const apiModelInput = document.getElementById("api-model");
const apiFormCancelBtn = document.getElementById("api-form-cancel");
const apiFormSaveBtn = document.getElementById("api-form-save");
const apiFormTestBtn = document.getElementById("api-form-test");
const apiTestStatusEl = document.getElementById("api-test-status");
const apiTestSpinner = document.getElementById("api-test-spinner");
const modalOverlay = document.getElementById("modal-overlay");
const modalEl = modalOverlay.querySelector(".modal");
const modalIconEl = document.getElementById("modal-icon");
const modalTitleEl = document.getElementById("modal-title");
const modalMessageEl = document.getElementById("modal-message");
const modalCancelBtn = document.getElementById("modal-cancel");
const modalConfirmBtn = document.getElementById("modal-confirm");
const choiceOverlay = document.getElementById("choice-overlay");
const choiceTitleEl = document.getElementById("choice-title");
const choiceMessageEl = document.getElementById("choice-message");
const choicePrimaryBtn = document.getElementById("choice-primary");
const choicePrimaryTitleEl = document.getElementById("choice-primary-title");
const choicePrimaryDescEl = document.getElementById("choice-primary-desc");
const choiceSecondaryBtn = document.getElementById("choice-secondary");
const choiceSecondaryTitleEl = document.getElementById("choice-secondary-title");
const choiceSecondaryDescEl = document.getElementById("choice-secondary-desc");
const choiceCancelBtn = document.getElementById("choice-cancel");
const promptOverlay = document.getElementById("prompt-overlay");
const promptTitleEl = document.getElementById("prompt-title");
const promptMessageEl = document.getElementById("prompt-message");
const promptLabelEl = document.getElementById("prompt-label");
const promptInputEl = document.getElementById("prompt-input");
const promptCancelBtn = document.getElementById("prompt-cancel");
const promptConfirmBtn = document.getElementById("prompt-confirm");
const langSelect = document.getElementById("lang-select");
const announcementBar = document.getElementById("announcement-bar");
const viewListBtn = document.getElementById("view-list-btn");
const viewGridBtn = document.getElementById("view-grid-btn");

// View mode (list | grid) persists in localStorage across restarts.
const VIEW_MODE_KEY = "codex-auth-view-mode";
let viewMode = localStorage.getItem(VIEW_MODE_KEY) === "grid" ? "grid" : "list";

function applyViewMode() {
  listEl.classList.toggle("grid-view", viewMode === "grid");
  viewListBtn.classList.toggle("active", viewMode === "list");
  viewGridBtn.classList.toggle("active", viewMode === "grid");
}

function setViewMode(mode) {
  if (mode === viewMode) return;
  viewMode = mode;
  localStorage.setItem(VIEW_MODE_KEY, mode);
  applyViewMode();
}

viewListBtn.addEventListener("click", () => setViewMode("list"));
viewGridBtn.addEventListener("click", () => setViewMode("grid"));

// Themed replacement for the native dialog.showMessageBox confirmations.
// Resolves true when confirmed; Esc / backdrop click / Cancel resolve false.
function showConfirm({ title, message, confirmLabel, cancelLabel, danger = false }) {
  confirmLabel = confirmLabel ?? t("confirm.ok");
  cancelLabel = cancelLabel ?? t("btn.cancel");
  return new Promise((resolve) => {
    modalTitleEl.textContent = title;
    modalMessageEl.textContent = message;
    modalCancelBtn.textContent = cancelLabel;
    modalConfirmBtn.textContent = confirmLabel;
    modalConfirmBtn.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
    modalIconEl.className = `modal-icon ${danger ? "danger" : "warn"}`;
    openOverlay(modalOverlay);
    modalConfirmBtn.focus();

    const close = (result) => {
      modalOverlay.classList.remove("visible");
      modalOverlay.addEventListener(
        "transitionend",
        () => modalOverlay.classList.add("hidden"),
        { once: true },
      );
      modalCancelBtn.removeEventListener("click", onCancel);
      modalConfirmBtn.removeEventListener("click", onConfirm);
      modalOverlay.removeEventListener("mousedown", onBackdrop);
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const onCancel = () => close(false);
    const onConfirm = () => close(true);
    const onBackdrop = (event) => {
      if (event.target === modalOverlay) close(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        close(true);
      }
    };
    modalCancelBtn.addEventListener("click", onCancel);
    modalConfirmBtn.addEventListener("click", onConfirm);
    modalOverlay.addEventListener("mousedown", onBackdrop);
    document.addEventListener("keydown", onKey, true);
  });
}

function closeOverlay(overlay) {
  overlay.classList.remove("visible");
  const hide = () => overlay.classList.add("hidden");
  overlay.addEventListener(
    "transitionend",
    hide,
    { once: true },
  );
  setTimeout(hide, 220);
}

function openOverlay(overlay) {
  overlay.classList.remove("hidden");
  void overlay.offsetWidth;
  overlay.classList.add("visible");
}

function setChoiceOption(titleEl, descEl, label, description = "") {
  titleEl.textContent = label;
  descEl.textContent = description;
  descEl.classList.toggle("hidden", !description);
}

function showChoice({ title, message, primaryLabel, primaryDescription, secondaryLabel, secondaryDescription, cancelLabel }) {
  cancelLabel = cancelLabel ?? t("btn.cancel");
  return new Promise((resolve) => {
    choiceTitleEl.textContent = title;
    choiceMessageEl.textContent = message;
    setChoiceOption(choicePrimaryTitleEl, choicePrimaryDescEl, primaryLabel, primaryDescription);
    setChoiceOption(choiceSecondaryTitleEl, choiceSecondaryDescEl, secondaryLabel, secondaryDescription);
    choiceCancelBtn.textContent = cancelLabel;
    openOverlay(choiceOverlay);
    choicePrimaryBtn.focus();

    const close = (result) => {
      closeOverlay(choiceOverlay);
      choicePrimaryBtn.removeEventListener("click", onPrimary);
      choiceSecondaryBtn.removeEventListener("click", onSecondary);
      choiceCancelBtn.removeEventListener("click", onCancel);
      choiceOverlay.removeEventListener("mousedown", onBackdrop);
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const onPrimary = () => close("primary");
    const onSecondary = () => close("secondary");
    const onCancel = () => close(null);
    const onBackdrop = (event) => {
      if (event.target === choiceOverlay) close(null);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
      }
    };
    choicePrimaryBtn.addEventListener("click", onPrimary);
    choiceSecondaryBtn.addEventListener("click", onSecondary);
    choiceCancelBtn.addEventListener("click", onCancel);
    choiceOverlay.addEventListener("mousedown", onBackdrop);
    document.addEventListener("keydown", onKey, true);
  });
}

function showPrompt({ title, message, label, confirmLabel, cancelLabel, placeholder = "", initialValue = "" }) {
  confirmLabel = confirmLabel ?? t("confirm.ok");
  cancelLabel = cancelLabel ?? t("btn.cancel");
  return new Promise((resolve) => {
    promptTitleEl.textContent = title;
    promptMessageEl.textContent = message;
    promptLabelEl.textContent = label;
    promptConfirmBtn.textContent = confirmLabel;
    promptCancelBtn.textContent = cancelLabel;
    promptInputEl.placeholder = placeholder;
    promptInputEl.value = initialValue;
    openOverlay(promptOverlay);
    promptInputEl.focus();
    promptInputEl.select();

    const close = (result) => {
      closeOverlay(promptOverlay);
      promptCancelBtn.removeEventListener("click", onCancel);
      promptConfirmBtn.removeEventListener("click", onConfirm);
      promptOverlay.removeEventListener("mousedown", onBackdrop);
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const onCancel = () => close(null);
    const onConfirm = () => close(promptInputEl.value.trim());
    const onBackdrop = (event) => {
      if (event.target === promptOverlay) close(null);
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
      } else if (event.key === "Enter") {
        event.preventDefault();
        close(promptInputEl.value.trim());
      }
    };
    promptCancelBtn.addEventListener("click", onCancel);
    promptConfirmBtn.addEventListener("click", onConfirm);
    promptOverlay.addEventListener("mousedown", onBackdrop);
    document.addEventListener("keydown", onKey, true);
  });
}

async function applyImportResult(result) {
  if (result.cancelled) return;
  if (!result.ok) {
    showToast(result.error ?? t("toast.importFailed"), "error");
    return;
  }
  if (result.registry?.ok) {
    registry = result.registry.data;
    render();
  }
  showToast(t("toast.imported", { added: result.added, updated: result.updated }), "success");
  checkAllAccounts({ silent: true });
}

let registry = null;
let busy = false;
let toastTimer = null;
let announcements = [];
// account_key -> { expired: boolean, error: string | null }
const accountStatuses = new Map();
// account_key -> { state: "pending" | "success" | "error", message: string }
const providerTestStatuses = new Map();

function showToast(message, kind = "info") {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = `toast ${kind}`;
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 3500);
}

function fmtReset(resetsAt) {
  if (!resetsAt) return "";
  const diffMs = resetsAt * 1000 - Date.now();
  if (diffMs <= 0) return t("reset.soon");
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return t("reset.minutes", { m: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 48) return t("reset.hours", { h: hours, m: mins % 60 });
  return t("reset.days", { d: Math.round(hours / 24) });
}

function fmtAgo(tsSec) {
  if (!tsSec) return null;
  const mins = Math.round((Date.now() - tsSec * 1000) / 60000);
  if (mins < 2) return t("ago.justNow");
  if (mins < 60) return t("ago.minutes", { m: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 48) return t("ago.hours", { h: hours });
  return t("ago.days", { d: Math.round(hours / 24) });
}

function usageRow(label, window) {
  const pct = Math.min(100, Math.max(0, window?.used_percent ?? 0));
  const cls = pct >= 90 ? "crit" : pct >= 70 ? "warn" : "";
  return `
    <div class="usage-row">
      <span class="usage-label">${label}</span>
      <div class="usage-track"><div class="usage-fill ${cls}" style="width:${pct}%"></div></div>
      <span class="usage-pct">${pct}%</span>
      <span class="usage-reset">${fmtReset(window?.resets_at)}</span>
    </div>`;
}

function esc(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function announcementText(announcement) {
  return [announcement.title, announcement.body].filter(Boolean).join(": ");
}

function announcementItemHtml(announcement, duplicate = false) {
  const url = announcement.url || "";
  const clickable = Boolean(url) && !duplicate;
  return `
    <span
      class="announcement-item ${url ? "clickable" : ""}"
      ${url ? `data-url="${esc(url)}"` : ""}
      ${clickable ? `role="link" tabindex="0" title="${esc(url)}"` : ""}
      ${duplicate ? "aria-hidden=\"true\"" : ""}
    >
      <span class="announcement-message">${esc(announcementText(announcement))}</span>
    </span>`;
}

function renderAnnouncements() {
  if (!announcementBar) return;
  const visible = announcements.filter((announcement) => announcement?.body);
  if (visible.length === 0) {
    announcementBar.classList.add("hidden");
    announcementBar.innerHTML = "";
    return;
  }

  const separator = `<span class="announcement-separator" aria-hidden="true">&bull;</span>`;
  const items = visible.map((announcement) => announcementItemHtml(announcement)).join(separator);
  const duplicateItems = visible.length > 1
    ? visible.map((announcement) => announcementItemHtml(announcement, true)).join(separator)
    : "";
  const duration = Math.max(18, Math.min(60, visible.reduce((sum, item) => sum + announcementText(item).length, 0) / 3));

  announcementBar.innerHTML = `
    <div class="announcement-icon" aria-hidden="true">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m3 11 18-5v12L3 14v-3Z" />
        <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
      </svg>
    </div>
    <div class="announcement-viewport">
      <div class="announcement-track ${visible.length > 1 ? "scrolling" : ""}" style="--announcement-duration:${duration}s">
        <span class="announcement-group">${items}</span>
        ${duplicateItems ? `<span class="announcement-group duplicate" aria-hidden="true">${separator}${duplicateItems}</span>` : ""}
      </div>
    </div>`;
  announcementBar.classList.remove("hidden");
}

async function loadAnnouncements() {
  if (!window.codexAuth.getAnnouncements) return;
  let result;
  try {
    result = await window.codexAuth.getAnnouncements({ locale: I18N.get() });
  } catch (error) {
    result = { ok: false, error: String(error) };
  }
  announcements = result.ok && Array.isArray(result.announcements) ? result.announcements : [];
  renderAnnouncements();
}

function render() {
  if (!registry) return;
  const accounts = registry.accounts ?? [];
  const activeKey = registry.active_account_key;

  const expiredCount = accounts.filter((a) => accountStatuses.get(a.account_key)?.expired).length;
  const summaryParts = [
    accounts.length > 1 ? t("summary.accountMany", { count: accounts.length }) : t("summary.accountOne"),
    expiredCount ? t("summary.expired", { count: expiredCount }) : null,
    t("summary.active", { email: accounts.find((a) => a.account_key === activeKey)?.email ?? t("summary.none") }),
  ].filter(Boolean);
  summaryEl.textContent = accounts.length ? summaryParts.join(" · ") : t("summary.noAccounts");

  emptyEl.classList.toggle("hidden", accounts.length > 0);
  listEl.classList.toggle("hidden", accounts.length === 0);

  const sorted = [...accounts].sort((a, b) => {
    if (a.account_key === activeKey) return -1;
    if (b.account_key === activeKey) return 1;
    return (b.last_used_at ?? 0) - (a.last_used_at ?? 0);
  });

  listEl.innerHTML = sorted
    .map((acc) => {
      const isActive = acc.account_key === activeKey;
      const isProvider = acc.auth_mode === "provider";
      const usage = acc.last_usage;
      const usageAgo = fmtAgo(acc.last_usage_at);
      const plan = isProvider ? "api" : (acc.last_usage?.plan_type || acc.plan || "unknown").toLowerCase();
      const status = accountStatuses.get(acc.account_key);
      const providerTestStatus = providerTestStatuses.get(acc.account_key);
      const isExpired = status?.expired === true;
      return `
      <div class="account-card ${isActive ? "active" : ""} ${isExpired ? "expired" : ""}" data-email="${esc(acc.email)}" data-key="${esc(acc.account_key)}">
        <div class="card-top">
          <div class="identity">
            <span class="email">${esc(acc.email)}</span>
            ${acc.alias ? `<span class="alias">${esc(acc.alias)}</span>` : ""}
          </div>
          <span class="badge badge-${esc(plan)}">${esc(plan)}</span>
          ${isExpired ? `<span class="badge badge-expired" title="${esc(status?.error ?? "")}">${esc(t("badge.expired"))}</span>` : ""}
          ${isActive ? `<span class="badge badge-active">${esc(t("badge.active"))}</span>` : ""}
          <div class="card-actions">
            ${isProvider
              ? `<button class="btn btn-secondary test-api-btn" title="${esc(t("card.testApi.tip"))}">
                  <span class="login-spinner ${providerTestStatus?.state === "pending" ? "" : "hidden"}"></span>
                  <span>${esc(t("card.testApi"))}</span>
                </button>`
              : `<button class="btn btn-ghost refresh-one-btn" title="${esc(t("card.refreshOne.tip"))}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            </button>`}
            <button class="btn btn-ghost export-one-btn" title="${esc(t("card.export.tip"))}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 3v12" />
                <path d="m7 8 5-5 5 5" />
                <path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
              </svg>
            </button>
            ${isActive ? "" : `<button class="btn btn-primary switch-btn">${esc(t("btn.switch"))}</button>`}
            <button class="btn btn-ghost remove-btn" title="${esc(t("card.remove.tip"))}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              </svg>
            </button>
          </div>
        </div>
        ${
          isProvider
            ? `<div class="no-usage">${esc(t("card.apiProvider", { base: acc.provider?.base_url ? ` · ${acc.provider.base_url}` : "" }))}</div>
               ${providerTestStatus
                 ? `<div class="provider-test-result ${esc(providerTestStatus.state)}">${esc(providerTestStatus.message)}</div>`
                 : ""}`
            : usage
              ? `<div class="usage-rows">
                  ${usageRow(t("usage.fiveHour"), usage.primary)}
                  ${usageRow(t("usage.weekly"), usage.secondary)}
                </div>
                ${usageAgo ? `<div class="usage-stale">${esc(t("usage.updated", { ago: usageAgo }))}</div>` : ""}`
              : `<div class="no-usage">${esc(t("usage.none"))}</div>`
        }
        ${isExpired ? `<div class="expired-note">${esc(status?.error ?? t("card.sessionExpired"))}</div>` : ""}
      </div>`;
    })
    .join("");
}

function setBusy(value) {
  busy = value;
  refreshBtn.disabled = value;
  loginBtn.disabled = value;
  emptyLoginBtn.disabled = value;
  addApiBtn.disabled = value;
  importBtn.disabled = value;
  exportBtn.disabled = value;
  apiFormSaveBtn.disabled = value;
  apiFormTestBtn.disabled = value;
  for (const btn of listEl.querySelectorAll("button")) btn.disabled = value;
}

function applyResult(result, successMsg) {
  if (result.registry?.ok) {
    registry = result.registry.data;
    render();
  }
  if (result.ok) {
    if (successMsg) showToast(successMsg, "success");
  } else if (!result.cancelled) {
    const detail = (result.stderr || result.error || "unknown error").trim().split("\n")[0];
    showToast(detail, "error");
  }
}

listEl.addEventListener("click", async (event) => {
  if (busy) return;
  const card = event.target.closest(".account-card");
  if (!card) return;
  const email = card.dataset.email;

  if (event.target.closest(".test-api-btn")) {
    providerTestStatuses.set(card.dataset.key, {
      state: "pending",
      message: t("api.testing"),
    });
    render();
    setBusy(true);
    let result;
    try {
      result = await window.codexAuth.testProviderAccount(card.dataset.key);
    } catch (error) {
      result = { ok: false, error: String(error) };
    }
    if (result.ok) {
      const message = t("api.ok", { status: result.status });
      providerTestStatuses.set(card.dataset.key, { state: "success", message });
      showToast(message, "success");
    } else {
      const message = `✕ ${result.error ?? t("toast.checkFailed")}`;
      providerTestStatuses.set(card.dataset.key, { state: "error", message });
      showToast(message, "error");
    }
    render();
    setBusy(false);
  } else if (event.target.closest(".refresh-one-btn")) {
    const btn = event.target.closest(".refresh-one-btn");
    setBusy(true);
    btn.disabled = true;
    btn.classList.add("spin");
    const result = await window.codexAuth.refreshAccountUsage(card.dataset.key);
    accountStatuses.set(card.dataset.key, { expired: result.expired === true, error: result.ok ? null : result.error });
    applyResult(result, t("toast.usageRefreshedFor", { email }));
    render();
    setBusy(false);
  } else if (event.target.closest(".export-one-btn")) {
    await runExportFlow({ accountKey: card.dataset.key, email });
  } else if (event.target.closest(".switch-btn")) {
    setBusy(true);
    const result = await window.codexAuth.switchAccount(card.dataset.key);
    applyResult(result, t("toast.switched", { email }));
    setBusy(false);
  } else if (event.target.closest(".remove-btn")) {
    const confirmed = await showConfirm({
      title: t("confirm.removeTitle", { email }),
      message: t("confirm.removeMessage"),
      confirmLabel: t("confirm.remove"),
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    const result = await window.codexAuth.removeAccount(card.dataset.key);
    applyResult(result, t("toast.removed", { email }));
    setBusy(false);
  }
});

announcementBar?.addEventListener("click", async (event) => {
  const item = event.target.closest(".announcement-item[data-url]");
  if (!item) return;
  const result = await window.codexAuth.openAnnouncementUrl(item.dataset.url);
  if (!result.ok) showToast(result.error ?? t("toast.openLinkFailed"), "error");
});

announcementBar?.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const item = event.target.closest(".announcement-item[data-url]");
  if (!item) return;
  event.preventDefault();
  const result = await window.codexAuth.openAnnouncementUrl(item.dataset.url);
  if (!result.ok) showToast(result.error ?? t("toast.openLinkFailed"), "error");
});

function applyStatuses(statuses) {
  for (const [key, status] of Object.entries(statuses ?? {})) {
    accountStatuses.set(key, { expired: status.expired === true, error: status.ok ? null : status.error });
  }
}

async function checkAllAccounts({ silent = false } = {}) {
  const result = await window.codexAuth.checkAccounts();
  if (!result.ok) {
    if (!silent) showToast(result.error ?? t("toast.checkFailed"), "error");
    return;
  }
  applyStatuses(result.statuses);
  if (result.registry?.ok) registry = result.registry.data;
  render();
  if (!silent) {
    const expired = Object.values(result.statuses).filter((s) => s.expired).length;
    const msg = expired
      ? (expired > 1 ? t("toast.refreshedExpiredMany", { count: expired }) : t("toast.refreshedExpiredOne"))
      : t("toast.usageRefreshed");
    showToast(msg, expired ? "error" : "success");
  }
}

refreshBtn.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  refreshBtn.classList.add("spin");
  await checkAllAccounts();
  refreshBtn.classList.remove("spin");
  setBusy(false);
});

async function startBrowserLogin() {
  if (busy) return;
  setBusy(true);
  loginBanner.classList.remove("hidden");
  const result = await window.codexAuth.loginStart();
  loginBanner.classList.add("hidden");
  applyResult(result, t("toast.accountAdded"));
  setBusy(false);
}

loginBtn.addEventListener("click", startBrowserLogin);
emptyLoginBtn.addEventListener("click", startBrowserLogin);

loginCancelBtn.addEventListener("click", () => {
  window.codexAuth.loginCancel();
});

function setApiTestStatus(state, message) {
  if (!state) {
    apiTestStatusEl.classList.add("hidden");
    apiTestStatusEl.textContent = "";
    apiTestStatusEl.className = "api-test-status hidden";
    return;
  }
  apiTestStatusEl.className = `api-test-status ${state}`;
  apiTestStatusEl.textContent = message;
}

function resetApiForm() {
  apiFormEl.classList.add("hidden");
  apiBaseUrlInput.value = "";
  apiKeyInput.value = "";
  apiNameInput.value = "";
  apiModelInput.value = "";
  setApiTestStatus(null);
}

addApiBtn.addEventListener("click", () => {
  if (busy) return;
  apiFormEl.classList.toggle("hidden");
  if (!apiFormEl.classList.contains("hidden")) apiBaseUrlInput.focus();
});

apiFormCancelBtn.addEventListener("click", () => {
  resetApiForm();
});

apiFormTestBtn.addEventListener("click", async () => {
  if (busy) return;
  const baseUrl = apiBaseUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  const model = apiModelInput.value.trim();
  if (!baseUrl || !apiKey) {
    setApiTestStatus("error", t("api.enterFirst"));
    return;
  }
  setBusy(true);
  apiTestSpinner.classList.remove("hidden");
  setApiTestStatus("pending", t("api.testing"));
  const result = await window.codexAuth.testApiEndpoint({ baseUrl, apiKey, model });
  apiTestSpinner.classList.add("hidden");
  if (result.ok) {
    const detail = [result.model ? `model: ${result.model}` : null, result.reply ? `reply: "${result.reply}"` : null]
      .filter(Boolean)
      .join(" · ");
    setApiTestStatus("success", `${t("api.ok", { status: result.status })}${detail ? ` — ${detail}` : ""}`);
  } else {
    setApiTestStatus("error", `✕ ${result.error}`);
  }
  setBusy(false);
});

apiFormSaveBtn.addEventListener("click", async () => {
  if (busy) return;
  const baseUrl = apiBaseUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  const name = apiNameInput.value.trim();
  const model = apiModelInput.value.trim();
  if (!baseUrl || !apiKey) {
    showToast(t("toast.apiRequired"), "error");
    return;
  }
  setBusy(true);
  apiTestSpinner.classList.remove("hidden");
  // Probe the endpoint first so a typo'd URL or bad key is caught before
  // adding; the user can still choose to add the account anyway.
  setApiTestStatus("pending", t("api.testingBeforeAdd"));
  const test = await window.codexAuth.testApiEndpoint({ baseUrl, apiKey, model });
  apiTestSpinner.classList.add("hidden");
  if (!test.ok) {
    setApiTestStatus("error", `✕ ${test.error}`);
    const proceed = await showConfirm({
      title: t("confirm.testFailedTitle"),
      message: t("confirm.testFailedMessage", { error: test.error }),
      confirmLabel: t("confirm.addAnyway"),
      danger: true,
    });
    if (!proceed) {
      setBusy(false);
      return;
    }
  } else {
    setApiTestStatus("success", t("api.okAdding", { status: test.status }));
  }
  const result = await window.codexAuth.loginApi({ baseUrl, apiKey, name, model });
  if (result.ok) {
    resetApiForm();
  } else if (!test.ok) {
    setApiTestStatus("error", `✕ ${test.error}`);
  } else {
    setApiTestStatus(null);
  }
  applyResult(result, t("toast.apiAdded"));
  setBusy(false);
});

function exportToastMessage(result, email) {
  if (result.scope === "single" && email) return t("toast.exportedFor", { email });
  return result.missing?.length
    ? t("toast.exportedPartial", { count: result.exported, missing: result.missing.length })
    : t("toast.exported", { count: result.exported });
}

async function runExportFlow({ accountKey = null, email = null } = {}) {
  if (busy) return;
  const isSingle = Boolean(accountKey);
  const label = email || accountKey || "";
  const choice = await showChoice({
    title: isSingle ? t("confirm.exportTitleOne", { email: label }) : t("confirm.exportTitle"),
    message: isSingle ? t("confirm.exportMessageOne") : t("confirm.exportMessage"),
    primaryLabel: t("confirm.exportFile"),
    primaryDescription: isSingle ? t("confirm.exportFileDescOne") : t("confirm.exportFileDesc"),
    secondaryLabel: t("confirm.exportShare"),
    secondaryDescription: isSingle ? t("confirm.exportShareDescOne") : t("confirm.exportShareDesc"),
  });
  if (!choice) return;

  if (choice === "secondary") {
    const confirmed = await showConfirm({
      title: t("confirm.exportShareWarnTitle"),
      message: isSingle ? t("confirm.exportShareWarnMessageOne", { email: label }) : t("confirm.exportShareWarnMessage"),
      confirmLabel: t("confirm.exportShareContinue"),
      danger: true,
    });
    if (!confirmed) return;

    const note = await showPrompt({
      title: t("confirm.exportShareNoteTitle"),
      message: isSingle ? t("confirm.exportShareNoteMessageOne") : t("confirm.exportShareNoteMessage"),
      label: t("confirm.exportShareNoteLabel"),
      confirmLabel: t("confirm.exportShareCreate"),
      placeholder: t("confirm.exportShareNotePlaceholder"),
    });
    if (note === null) return;

    setBusy(true);
    let result;
    try {
      result = await window.codexAuth.exportAccountsShare({
        note: note || null,
        ttlDays: 7,
        ...(isSingle ? { accountKey } : {}),
      });
    } catch (error) {
      result = { ok: false, error: String(error) };
    }
    setBusy(false);
    if (!result.ok) {
      showToast(result.error ?? t("toast.exportShareFailed"), "error");
      return;
    }

    const copied = await showPrompt({
      title: t("confirm.exportShareDoneTitle"),
      message: isSingle
        ? t("confirm.exportShareDoneMessageOne", { email: label, expires: result.expiresAt })
        : t("confirm.exportShareDoneMessage", { count: result.exported, expires: result.expiresAt }),
      label: t("confirm.exportShareLinkLabel"),
      confirmLabel: t("confirm.exportShareCopy"),
      initialValue: result.shareUrl,
    });
    if (copied) {
      try {
        await navigator.clipboard.writeText(result.shareUrl);
        showToast(t("toast.exportShareCopied"), "success");
      } catch {
        showToast(t("toast.exportShareCreated"), "success");
      }
    } else {
      showToast(t("toast.exportShareCreated"), "success");
    }
    return;
  }

  setBusy(true);
  let result;
  try {
    result = await window.codexAuth.exportAccounts(isSingle ? { accountKey } : undefined);
  } catch (error) {
    result = { ok: false, error: String(error) };
  }
  setBusy(false);
  if (result.cancelled) return;
  if (!result.ok) {
    showToast(result.error ?? t("toast.exportFailed"), "error");
    return;
  }
  const message = exportToastMessage(result, label);
  showToast(message, result.missing?.length ? "info" : "success");
}

exportBtn.addEventListener("click", () => {
  runExportFlow();
});

importBtn.addEventListener("click", async () => {
  if (busy) return;
  const choice = await showChoice({
    title: t("confirm.importTitle"),
    message: t("confirm.importMessage"),
    primaryLabel: t("confirm.import"),
    primaryDescription: t("confirm.importDesc"),
    secondaryLabel: t("confirm.importLink"),
    secondaryDescription: t("confirm.importLinkDesc"),
  });
  if (!choice) return;

  if (choice === "secondary") {
    const url = await showPrompt({
      title: t("confirm.importLinkTitle"),
      message: t("confirm.importLinkMessage"),
      label: t("confirm.importLinkLabel"),
      confirmLabel: t("confirm.importLinkContinue"),
      placeholder: "https://codexhub.uk/share/...",
    });
    if (!url) return;

    setBusy(true);
    let result;
    try {
      result = await window.codexAuth.importAccountsFromUrl({ url });
    } catch (error) {
      result = { ok: false, error: String(error) };
    }
    setBusy(false);
    await applyImportResult(result);
    return;
  }

  setBusy(true);
  let result;
  try {
    result = await window.codexAuth.importAccounts();
  } catch (error) {
    result = { ok: false, error: String(error) };
  }
  setBusy(false);
  await applyImportResult(result);
});

langSelect.addEventListener("change", () => {
  I18N.set(langSelect.value);
  render();
  loadAnnouncements();
});

window.codexAuth.onRegistryChanged((payload) => {
  if (busy) return;
  if (payload.ok) {
    registry = payload.data;
    render();
  }
});

(async function init() {
  langSelect.value = I18N.get();
  I18N.apply();
  applyViewMode();
  loadAnnouncements();
  const appVersion = await window.codexAuth.getAppVersion?.();
  if (appVersion) {
    appVersionEl.textContent = `v${appVersion}`;
    appVersionEl.classList.remove("hidden");
  }
  const payload = await window.codexAuth.getRegistry();
  if (payload.ok) {
    registry = payload.data;
    render();
    // Validate every stored session in the background so expired accounts
    // are flagged without requiring a manual refresh.
    checkAllAccounts({ silent: true });
  } else {
    summaryEl.textContent = "";
    emptyEl.classList.remove("hidden");
    showToast(payload.error, "error");
  }
})();
