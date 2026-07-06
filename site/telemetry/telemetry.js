const SUMMARY_ENDPOINT = "https://codex-auth-telemetry.xuliang2022.workers.dev/v1/telemetry/summary";

const state = {
  data: null,
};

function $(id) {
  return document.getElementById(id);
}

function fmtNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function fmtTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function esc(value) {
  const div = document.createElement("div");
  div.textContent = value ?? "";
  return div.innerHTML;
}

function compactJson(value) {
  const entries = Object.entries(value || {});
  if (entries.length === 0) return "{}";
  return entries
    .map(([key, item]) => `${key}: ${typeof item === "object" && item !== null ? JSON.stringify(item) : item}`)
    .join(" · ");
}

function renderMetric(id, value) {
  $(id).textContent = value;
}

function renderBars(id, rows, labelKey) {
  const host = $(id);
  const max = Math.max(1, ...rows.map((row) => Number(row.count || 0)));
  if (rows.length === 0) {
    host.innerHTML = `<div class="empty-note">No data yet</div>`;
    return;
  }
  host.innerHTML = rows
    .map((row) => {
      const label = row[labelKey] || "unknown";
      const count = Number(row.count || 0);
      const width = Math.max(5, Math.round((count / max) * 100));
      return `
        <div class="bar-row">
          <div class="bar-label">
            <span>${esc(label)}</span>
            <strong>${fmtNumber(count)}</strong>
          </div>
          <div class="bar-track"><span style="width:${width}%"></span></div>
        </div>`;
    })
    .join("");
}

function renderDayStrip(rows) {
  const host = $("events-by-day");
  const max = Math.max(1, ...rows.map((row) => Number(row.count || 0)));
  if (rows.length === 0) {
    host.innerHTML = `<div class="empty-note">No event trend yet</div>`;
    return;
  }
  host.innerHTML = rows
    .map((row) => {
      const count = Number(row.count || 0);
      const height = Math.max(8, Math.round((count / max) * 100));
      return `
        <div class="day-column" title="${esc(row.day)} · ${fmtNumber(count)} events">
          <span style="height:${height}%"></span>
          <small>${esc(row.day.slice(5))}</small>
        </div>`;
    })
    .join("");
}

function renderSnapshot(snapshot) {
  const host = $("account-snapshot");
  if (!snapshot) {
    host.innerHTML = `<div class="empty-note">No app start snapshot yet</div>`;
    return;
  }
  const props = snapshot.properties || {};
  const authModes = props.auth_mode_counts || {};
  const plans = props.plan_counts || {};
  host.innerHTML = `
    <div class="snapshot-main">
      <span>Accounts</span>
      <strong>${fmtNumber(props.account_count || 0)}</strong>
      <small>${esc(snapshot.app_version || "unknown")} · ${esc(snapshot.platform || "unknown")} · ${esc(snapshot.locale || "unknown")}</small>
    </div>
    <div class="snapshot-list">
      <span>Auth modes</span>
      <strong>${esc(compactJson(authModes))}</strong>
    </div>
    <div class="snapshot-list">
      <span>Plans</span>
      <strong>${esc(compactJson(plans))}</strong>
    </div>
    <div class="snapshot-list">
      <span>Received</span>
      <strong>${fmtTime(snapshot.received_at)}</strong>
    </div>`;
}

function renderRecent(events) {
  const body = $("recent-events");
  if (!events.length) {
    body.innerHTML = `<tr><td colspan="6">No recent events</td></tr>`;
    return;
  }
  body.innerHTML = events
    .map((event) => `
      <tr>
        <td>${esc(event.event_name)}</td>
        <td>${esc(event.app_version || "unknown")}</td>
        <td>${esc(event.platform || "unknown")}</td>
        <td>${esc(event.locale || "unknown")}</td>
        <td>${fmtTime(event.received_at)}</td>
        <td>${esc(compactJson(event.properties))}</td>
      </tr>`)
    .join("");
}

function render(data) {
  state.data = data;
  renderMetric("metric-installs", fmtNumber(data.totals?.installs));
  renderMetric("metric-events", fmtNumber(data.totals?.events));
  renderMetric("metric-events-24h", fmtNumber(data.totals?.events_24h));
  renderMetric("metric-last-event", fmtTime(data.totals?.last_event_at));
  $("telemetry-updated").textContent = `Updated ${fmtTime(data.generated_at)}`;
  $("telemetry-status").textContent = "Live";

  renderSnapshot(data.latest_account_snapshot);
  renderBars("events-by-name", data.events_by_name || [], "event_name");
  renderBars("installs-by-version", data.installs_by_version || [], "app_version");
  renderDayStrip(data.events_by_day || []);
  renderRecent(data.recent_events || []);
}

async function loadTelemetry() {
  $("telemetry-status").textContent = "Loading";
  try {
    const response = await fetch(SUMMARY_ENDPOINT, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "Unknown response");
    render(data);
  } catch (error) {
    $("telemetry-status").textContent = "Offline";
    $("telemetry-updated").textContent = `Could not load data: ${error.message}`;
  }
}

$("refresh-telemetry").addEventListener("click", loadTelemetry);
loadTelemetry();
