import assert from "node:assert/strict";
import test from "node:test";
import worker, { internals } from "./worker.js";

function createFakeD1({ announcements = [], summary = {} } = {}) {
  const batches = [];
  const runs = [];
  return {
    batches,
    runs,
    prepare(sql) {
      return {
        sql,
        bind(...params) {
          return {
            sql,
            params,
            async all() {
              if (sql.includes("FROM telemetry_events") && sql.includes("GROUP BY event_name")) {
                return { results: summary.eventsByName ?? [] };
              }
              if (sql.includes("FROM telemetry_installs") && sql.includes("GROUP BY COALESCE")) {
                return { results: summary.installsByVersion ?? [] };
              }
              if (sql.includes("FROM telemetry_events") && sql.includes("GROUP BY substr")) {
                return { results: summary.eventsByDay ?? [] };
              }
              if (sql.includes("FROM telemetry_events") && sql.includes("ORDER BY id DESC")) {
                return { results: summary.recentEvents ?? [] };
              }
              if (!sql.includes("FROM announcements")) return { results: [] };
              const [startsNow, endsNow, locale, platform] = params;
              const results = announcements.filter((row) => {
                if (row.enabled === 0) return false;
                if (row.starts_at && row.starts_at > startsNow) return false;
                if (row.ends_at && row.ends_at <= endsNow) return false;
                if (row.locale !== "all" && row.locale !== locale) return false;
                if (row.platform !== "all" && row.platform !== platform) return false;
                return true;
              }).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
              return { results };
            },
            async first() {
              if (sql.includes("FROM telemetry_installs")) {
                return summary.installTotals ?? {};
              }
              if (sql.includes("FROM telemetry_events") && sql.includes("events_24h")) {
                return summary.events24h ?? {};
              }
              if (sql.includes("FROM telemetry_events") && sql.includes("event_name = 'app_start'")) {
                return summary.latestSnapshot ?? {};
              }
              if (sql.includes("FROM telemetry_events")) {
                return summary.eventTotals ?? {};
              }
              return {};
            },
            async run() {
              runs.push({ sql, params });
              return { success: true, meta: { last_row_id: 42 } };
            },
          };
        },
      };
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ success: true }));
    },
  };
}

function request(path, init = {}) {
  return new Request(`https://telemetry.example.test${path}`, init);
}

test("health endpoint returns service status", async () => {
  const response = await worker.fetch(request("/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "codex-auth-telemetry",
  });
});

test("telemetry endpoint writes install and event statements", async () => {
  const db = createFakeD1();
  const response = await worker.fetch(
    request("/v1/telemetry/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        install_id: "install-123",
        app: "codex-auth-desktop",
        app_version: "0.1.1",
        platform: "darwin",
        locale: "zh",
        events: [
          {
            name: "app_start",
            time: 1783260000,
            properties: {
              account_count: 5,
              auth_mode_counts: { chatgpt: 4, provider: 1 },
              plan_counts: { pro: 1, plus: 2, go: 1, api: 1 },
            },
          },
        ],
      }),
    }),
    { TELEMETRY_DB: db },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, accepted: 1 });
  assert.equal(db.batches.length, 1);
  assert.equal(db.batches[0].length, 2);
  assert.equal(db.batches[0][0].params[0], "install-123");
  assert.equal(db.batches[0][1].params[5], "app_start");
});

test("telemetry endpoint rejects sensitive properties", async () => {
  const db = createFakeD1();
  const response = await worker.fetch(
    request("/v1/telemetry/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        install_id: "install-123",
        events: [
          {
            name: "bad_event",
            properties: {
              email: "person@example.com",
            },
          },
        ],
      }),
    }),
    { TELEMETRY_DB: db },
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /sensitive key/);
  assert.equal(db.batches.length, 0);
});

test("payload validator rejects URL-like string values", () => {
  assert.throws(
    () => internals.validatePayload({
      install_id: "install-123",
      events: [
        {
          name: "bad_event",
          properties: {
            message: "failed at https://example.com/path",
          },
        },
      ],
    }),
    /sensitive string/,
  );
});

test("telemetry summary endpoint returns aggregate-only stats", async () => {
  const db = createFakeD1({
    summary: {
      installTotals: { total_installs: 1, last_seen_at: "2026-07-05T22:59:13.916Z" },
      eventTotals: { total_events: 2, last_event_at: "2026-07-05T23:00:00.000Z" },
      events24h: { events_24h: 2 },
      eventsByName: [{ event_name: "app_start", count: 2 }],
      installsByVersion: [{ app_version: "0.1.1", count: 1 }],
      eventsByDay: [{ day: "2026-07-05", count: 2 }],
      latestSnapshot: {
        app_version: "0.1.1",
        platform: "darwin",
        locale: "zh-CN",
        received_at: "2026-07-05T22:59:13.916Z",
        properties_json: JSON.stringify({
          account_count: 5,
          auth_mode_counts: { chatgpt: 4, provider: 1 },
          plan_counts: { pro: 1, plus: 2, go: 1, api: 1 },
        }),
      },
      recentEvents: [
        {
          event_name: "app_start",
          app_version: "0.1.1",
          platform: "darwin",
          locale: "zh-CN",
          received_at: "2026-07-05T22:59:13.916Z",
          properties_json: "{\"account_count\":5}",
        },
      ],
    },
  });

  const response = await worker.fetch(request("/v1/telemetry/summary"), { TELEMETRY_DB: db });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.totals.installs, 1);
  assert.equal(body.totals.events, 2);
  assert.deepEqual(body.events_by_name, [{ event_name: "app_start", count: 2 }]);
  assert.equal(body.latest_account_snapshot.properties.account_count, 5);
  assert.equal(body.recent_events[0].properties.account_count, 5);
  assert.equal("install_id" in body.recent_events[0], false);
});

test("announcements endpoint returns active targeted announcements", async () => {
  const db = createFakeD1({
    announcements: [
      {
        id: 1,
        title: "Release",
        body: "Accounts for Codex 0.1.2 is available",
        link_url: "https://example.com/releases/0.1.2",
        locale: "en",
        platform: "darwin",
        min_version: null,
        max_version: null,
        priority: 5,
        enabled: 1,
      },
      {
        id: 2,
        title: "Ignored",
        body: "This is for Windows only",
        link_url: null,
        locale: "all",
        platform: "win32",
        min_version: null,
        max_version: null,
        priority: 10,
        enabled: 1,
      },
      {
        id: 3,
        title: "Plain",
        body: "No link announcement",
        link_url: "javascript:alert(1)",
        locale: "all",
        platform: "all",
        min_version: "0.1.0",
        max_version: "0.1.9",
        priority: 1,
        enabled: 1,
      },
    ],
  });

  const response = await worker.fetch(
    request("/v1/announcements?app=codex-auth-desktop&version=0.1.1&platform=darwin&locale=en"),
    { TELEMETRY_DB: db },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.ttl_seconds, 300);
  assert.deepEqual(body.announcements, [
    {
      id: 1,
      title: "Release",
      body: "Accounts for Codex 0.1.2 is available",
      url: "https://example.com/releases/0.1.2",
      priority: 5,
    },
    {
      id: 3,
      title: "Plain",
      body: "No link announcement",
      url: null,
      priority: 1,
    },
  ]);
});

test("announcements endpoint filters by client version", async () => {
  const db = createFakeD1({
    announcements: [
      {
        id: 1,
        title: "Future",
        body: "Requires a newer app",
        link_url: null,
        locale: "all",
        platform: "all",
        min_version: "0.2.0",
        max_version: null,
        priority: 10,
        enabled: 1,
      },
      {
        id: 2,
        title: "Current",
        body: "Works here",
        link_url: null,
        locale: "all",
        platform: "all",
        min_version: "0.1.0",
        max_version: "0.1.9",
        priority: 1,
        enabled: 1,
      },
    ],
  });

  const response = await worker.fetch(
    request("/v1/announcements?version=0.1.1&platform=darwin&locale=zh"),
    { TELEMETRY_DB: db },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.announcements.map((item) => item.id), [2]);
});

test("announcements admin endpoint requires a token", async () => {
  const db = createFakeD1();
  const response = await worker.fetch(
    request("/v1/announcements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Nope" }),
    }),
    { TELEMETRY_DB: db, ANNOUNCEMENT_ADMIN_TOKEN: "secret" },
  );

  assert.equal(response.status, 401);
  assert.equal(db.runs.length, 0);
});

test("announcements admin endpoint inserts a validated announcement", async () => {
  const db = createFakeD1();
  const response = await worker.fetch(
    request("/v1/announcements", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-announcement-token": "secret",
      },
      body: JSON.stringify({
        title: "Release",
        body: "Accounts for Codex 0.1.2 is available",
        url: "https://example.com/releases/0.1.2",
        locale: "en",
        platform: "darwin",
        min_version: "0.1.0",
        max_version: "0.1.9",
        priority: 7,
        starts_at: "2026-07-06T00:00:00Z",
      }),
    }),
    { TELEMETRY_DB: db, ANNOUNCEMENT_ADMIN_TOKEN: "secret" },
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, id: 42 });
  assert.equal(db.runs.length, 1);
  assert.equal(db.runs[0].params[0], "Release");
  assert.equal(db.runs[0].params[1], "Accounts for Codex 0.1.2 is available");
  assert.equal(db.runs[0].params[2], "https://example.com/releases/0.1.2");
  assert.equal(db.runs[0].params[3], "en");
  assert.equal(db.runs[0].params[4], "darwin");
  assert.equal(db.runs[0].params[7], 7);
});
