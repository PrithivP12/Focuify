import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

function element() {
  const listeners = new Map();
  return {
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    textContent: "",
    style: {},
    classList: { toggle() {} },
    setAttribute() {},
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    trigger(type) {
      listeners.get(type)?.();
    },
  };
}

test("popup flushes changed settings when it closes", async () => {
  const source = await readFile(
    new URL("../popup.js", import.meta.url),
    "utf8",
  );
  const ids = [
    ...new Set(
      [...source.matchAll(/\$\("([^"]+)"\)/g)].map((match) => match[1]),
    ),
  ];
  const elements = new Map(ids.map((id) => [id, element()]));
  const windowListeners = new Map();
  const messages = [];
  const initialSettings = {
    enabled: false,
    focusGoal: "",
    similarityThreshold: 0.35,
    allowDomains: [],
    blockDomains: [],
    themeMode: "light",
    fontScale: 1,
    highContrast: false,
    reducedMotion: false,
  };
  const context = {
    console,
    setTimeout,
    clearTimeout,
    document: {
      body: { dataset: {} },
      documentElement: { style: {} },
      getElementById(id) {
        return elements.get(id);
      },
    },
    window: {
      addEventListener(type, handler) {
        windowListeners.set(type, handler);
      },
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          messages.push(message);
          callback(
            message.type === "GET_SETTINGS"
              ? {
                  ok: true,
                  settings: initialSettings,
                  enrollment: null,
                  classManaged: false,
                }
              : {
                  ok: true,
                  settings: { ...initialSettings, ...message.payload },
                  enrollment: null,
                  classManaged: false,
                },
          );
        },
      },
    },
  };
  vm.runInNewContext(source, context);
  await Promise.resolve();
  elements.get("themeMode").value = "dark";
  elements.get("themeMode").trigger("input");
  windowListeners.get("pagehide")();
  await Promise.resolve();
  const saved = messages.findLast(
    (message) => message.type === "SAVE_SETTINGS",
  );
  assert.equal(saved.payload.themeMode, "dark");
});
