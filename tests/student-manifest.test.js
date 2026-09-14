import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";

test("student manifest exposes only the minimal extension surface", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    manifest.permissions.sort(),
    ["offscreen", "scripting", "storage", "tabs", "webNavigation"].sort(),
  );
  assert.deepEqual(manifest.host_permissions, ["http://*/*", "https://*/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "http://*/*",
    "https://*/*",
  ]);
  assert.equal(manifest.content_scripts[0].js[0], "content_script.js");
  assert.equal("side_panel" in manifest, false);
  assert.equal("commands" in manifest, false);
  assert.equal("web_accessible_resources" in manifest, false);
  await access(
    new URL("../sidepanel.html", import.meta.url),
    constants.F_OK,
  ).then(
    () => assert.fail("sidepanel should be removed"),
    () => {},
  );
  await access(
    new URL("../coach/qwenRuntime.js", import.meta.url),
    constants.F_OK,
  ).then(
    () => assert.fail("chat runtime should be removed"),
    () => {},
  );
});

test("student telemetry cannot transmit browsing evidence", async () => {
  const worker = await readFile(
    new URL("../service_worker.js", import.meta.url),
    "utf8",
  );
  assert.match(worker, /\/v1\/student\/status/);
  assert.doesNotMatch(worker, /\/v1\/student\/events/);
  assert.match(worker, /JSON\.stringify\(\{ status \}\)/);
  assert.doesNotMatch(worker, /blockedUrl\.searchParams\.set\("url"/);
  assert.match(
    worker,
    /chrome\.storage\.local\.setAccessLevel\(\{\s*accessLevel: "TRUSTED_CONTEXTS",?\s*\}\)/,
  );
});

test("teacher-managed sessions lock student bypasses and site rules", async () => {
  const worker = await readFile(
    new URL("../service_worker.js", import.meta.url),
    "utf8",
  );
  const popup = await readFile(new URL("../popup.js", import.meta.url), "utf8");
  assert.match(
    worker,
    /async function allowOnceOpen[\s\S]*?if \(classSession\)\s*throw new Error/,
  );
  assert.match(
    worker,
    /async function allowDomainOpen[\s\S]*?if \(classSession\)\s*throw new Error/,
  );
  assert.match(
    worker,
    /async function applyTeacherPolicy[\s\S]*?allowDomains:\s*\[\],\s*blockDomains:\s*\[\]/,
  );
  assert.match(
    popup,
    /\[\s*enabled,\s*focusGoal,\s*threshold,\s*allowDomains,\s*blockDomains,?\s*\]/,
  );
});
