import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFocusServer } from "../server/index.js";
import { FocusStore } from "../server/db.js";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "focuify-test-"));
  const dbPath = path.join(directory, "test.sqlite");
  const server = createFocusServer({ dbPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, options = {}) {
    const response = await fetch(`${base}${route}`, {
      headers: {
        "content-type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }
  return {
    request,
    store: server.focusStore,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      server.focusStore.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function registerTeacher(app, email = "teacher@example.com") {
  const registration = await app.request("/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email,
      name: "Teacher One",
      password: "a-secure-password",
    }),
  });
  assert.equal(registration.response.status, 201);
  return { authorization: `Bearer ${registration.data.token}` };
}

test("critical classroom flow exposes status and aggregates without browsing activity", async () => {
  const app = await fixture();
  try {
    const teacherHeaders = await registerTeacher(app);
    const created = await app.request("/v1/classes", {
      method: "POST",
      headers: teacherHeaders,
      body: JSON.stringify({ name: "Biology · Period 2" }),
    });
    assert.equal(created.response.status, 201);
    assert.match(created.data.class.classCode, /^[A-Z2-9]{6}$/);

    const joined = await app.request("/v1/join", {
      method: "POST",
      body: JSON.stringify({
        classCode: created.data.class.classCode,
        name: "Student One",
        deviceId: "focuify-test-device",
      }),
    });
    assert.equal(joined.response.status, 201);
    const studentHeaders = { authorization: `Bearer ${joined.data.token}` };

    const started = await app.request(
      `/v1/classes/${created.data.class.id}/policy`,
      {
        method: "PATCH",
        headers: teacherHeaders,
        body: JSON.stringify({
          enabled: true,
          focusGoal: "cellular respiration",
          similarityThreshold: 0.42,
          searchGuardEnabled: true,
        }),
      },
    );
    assert.equal(started.response.status, 200);
    assert.equal(started.data.class.policy.enabled, true);

    const synced = await app.request("/v1/student/policy-sync", {
      headers: studentHeaders,
    });
    assert.equal(synced.response.status, 200);
    assert.equal(synced.data.class.policy.focusGoal, "cellular respiration");

    const focused = await app.request("/v1/student/status", {
      method: "POST",
      headers: studentHeaders,
      body: JSON.stringify({ status: "focused" }),
    });
    assert.equal(focused.response.status, 200);

    const rejectedBrowsingData = await app.request("/v1/student/status", {
      method: "POST",
      headers: studentHeaders,
      body: JSON.stringify({
        status: "blocked",
        url: "https://example.com/private?q=search",
        title: "Private page",
      }),
    });
    assert.equal(rejectedBrowsingData.response.status, 400);
    assert.equal(rejectedBrowsingData.data.error.code, "unexpected_fields");

    const blocked = await app.request("/v1/student/status", {
      method: "POST",
      headers: studentHeaders,
      body: JSON.stringify({ status: "blocked" }),
    });
    assert.equal(blocked.response.status, 200);

    const removedEndpoint = await app.request("/v1/student/events", {
      method: "POST",
      headers: studentHeaders,
      body: JSON.stringify({ action: "blocked", domain: "example.com" }),
    });
    assert.equal(removedEndpoint.response.status, 404);

    const overview = await app.request(
      `/v1/classes/${created.data.class.id}/overview`,
      { headers: teacherHeaders },
    );
    assert.equal(overview.response.status, 200);
    assert.equal(overview.data.students[0].status, "blocked");
    assert.equal("blockedCount" in overview.data.students[0], false);
    assert.equal(overview.data.totals.blocked, 1);
    assert.equal(overview.data.totals.blockedAttempts, 1);
    assert.equal("domains" in overview.data, false);
    assert.equal("activity" in overview.data, false);
    const serialized = JSON.stringify(overview.data);
    for (const forbidden of [
      "example.com",
      "private?q=search",
      "Private page",
      "domain",
      "url",
      "query",
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }

    const ended = await app.request(
      `/v1/classes/${created.data.class.id}/policy`,
      {
        method: "PATCH",
        headers: teacherHeaders,
        body: JSON.stringify({
          enabled: false,
          focusGoal: "cellular respiration",
          similarityThreshold: 0.42,
          searchGuardEnabled: true,
        }),
      },
    );
    assert.equal(ended.response.status, 200);
    const afterEnd = await app.request(
      `/v1/classes/${created.data.class.id}/overview`,
      { headers: teacherHeaders },
    );
    assert.equal(afterEnd.data.session.active, false);
    assert.equal(afterEnd.data.students[0].status, "session ended");
    assert.equal(
      app.store.db
        .prepare("SELECT COUNT(*) AS count FROM student_session_status")
        .get().count,
      0,
    );
  } finally {
    await app.close();
  }
});

test("teacher ownership is enforced and class codes rotate", async () => {
  const app = await fixture();
  try {
    const ownerHeaders = await registerTeacher(app, "owner@example.com");
    const otherHeaders = await registerTeacher(app, "other@example.com");
    const created = await app.request("/v1/classes", {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ name: "History" }),
    });
    const forbidden = await app.request(
      `/v1/classes/${created.data.class.id}/overview`,
      { headers: otherHeaders },
    );
    assert.equal(forbidden.response.status, 404);
    const rotated = await app.request(
      `/v1/classes/${created.data.class.id}/rotate-code`,
      { method: "POST", headers: ownerHeaders },
    );
    assert.equal(rotated.response.status, 200);
    assert.notEqual(rotated.data.class.classCode, created.data.class.classCode);
    for (const [name, deviceId] of [
      ["Student One", "bulk-test-device-1"],
      ["Student Two", "bulk-test-device-2"],
    ]) {
      const joined = await app.request("/v1/join", {
        method: "POST",
        body: JSON.stringify({
          classCode: rotated.data.class.classCode,
          name,
          deviceId,
        }),
      });
      assert.equal(joined.response.status, 201);
    }
    const rejectedBulkRemove = await app.request(
      `/v1/classes/${created.data.class.id}/students`,
      { method: "DELETE", headers: otherHeaders },
    );
    assert.equal(rejectedBulkRemove.response.status, 404);
    const removed = await app.request(
      `/v1/classes/${created.data.class.id}/students`,
      { method: "DELETE", headers: ownerHeaders },
    );
    assert.equal(removed.response.status, 200);
    assert.equal(removed.data.removed, 2);
    const emptyOverview = await app.request(
      `/v1/classes/${created.data.class.id}/overview`,
      { headers: ownerHeaders },
    );
    assert.equal(emptyOverview.data.students.length, 0);
  } finally {
    await app.close();
  }
});

test("privacy migration deletes the legacy browsing event table", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "focuify-migration-"));
  const dbPath = path.join(directory, "legacy.sqlite");
  try {
    const initial = new FocusStore(dbPath);
    initial.close();
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(
      "CREATE TABLE events (id INTEGER PRIMARY KEY, domain TEXT, page_title TEXT, occurred_at TEXT)",
    );
    legacy
      .prepare(
        "INSERT INTO events (domain, page_title, occurred_at) VALUES (?, ?, ?)",
      )
      .run("example.com", "Private title", new Date().toISOString());
    legacy.close();
    const migrated = new FocusStore(dbPath);
    const tables = migrated.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    assert.equal(tables.includes("events"), false);
    assert.equal(tables.includes("focus_sessions"), true);
    assert.equal(tables.includes("student_session_status"), true);
    migrated.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
