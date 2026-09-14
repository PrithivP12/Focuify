import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureModelDocument,
  requestTextRanking,
} from "../local-model/client.js";

test("concurrent ranking requests create one offscreen document and return bounded metadata", async () => {
  let creates = 0;
  let present = false;
  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      getContexts: async () => (present ? [{}] : []),
      sendMessage: async (message) => {
        assert.deepEqual(message, {
          target: "focuify-text-ranking",
          query: "cellular respiration",
          documents: ["A lesson about ATP"],
        });
        return {
          ok: true,
          scores: [0.87],
          modelVersion: "v4",
          backend: "wasm",
          durationMs: 18,
          loadDurationMs: 140,
        };
      },
    },
    offscreen: {
      createDocument: async () => {
        creates += 1;
        await new Promise((resolve) => setImmediate(resolve));
        present = true;
      },
    },
  };
  await Promise.all([
    ensureModelDocument(),
    ensureModelDocument(),
    ensureModelDocument(),
  ]);
  assert.equal(creates, 1);
  const output = await requestTextRanking("cellular respiration", [
    "A lesson about ATP",
  ]);
  assert.deepEqual(output, {
    scores: [0.87],
    modelVersion: "v4",
    backend: "wasm",
    durationMs: 18,
    loadDurationMs: 140,
  });
  chrome.runtime.sendMessage = async () => ({ ok: false, error: "offline" });
  await assert.rejects(requestTextRanking("a goal", ["a document"]), /offline/);
});

test("failed offscreen document creation can be retried", async () => {
  let tries = 0;
  chrome.runtime.getContexts = async () => [];
  chrome.offscreen.createDocument = async () => {
    if (++tries === 1) throw new Error("unavailable");
  };
  await assert.rejects(ensureModelDocument(), /unavailable/);
  await ensureModelDocument();
  assert.equal(tries, 2);
});
