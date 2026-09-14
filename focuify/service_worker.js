import { requestTextRanking } from "./local-model/client.js";
import {
  compactPageEvidence,
  rankingDocuments,
  sanitizeText,
} from "./keywordUtils.js";

const DEFAULT_SIMILARITY_THRESHOLD = 0.5;
const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  focusGoal: "",
  similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
  allowDomains: [],
  blockDomains: [],
  themeMode: "light",
  fontScale: 1,
  highContrast: false,
  reducedMotion: false,
});

const DECISION_CACHE_TTL_MS = 15 * 60 * 1000;
const DECISION_CACHE_MAX = 800;
const ONE_TIME_BYPASS_TTL_MS = 10 * 60 * 1000;
const BLOCKED_CONTEXT_PREFIX = "blockedContext:";

let settings = { ...DEFAULT_SETTINGS };
let modelWarmPromise = null;
let isReady = false;
const decisionCache = new Map();
const oneTimeBypassByTab = new Map();
const blockingTabs = new Set();
const initPromise = init();

chrome.runtime.onInstalled.addListener(() => {
  void hydrateSettings();
});
chrome.runtime.onStartup.addListener(() => {
  void hydrateSettings();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const patch = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (changes[key]) patch[key] = changes[key].newValue;
  }
  if (!Object.keys(patch).length) return;
  settings = sanitizeSettings({ ...settings, ...patch });
  clearDecisionCache();
  if (
    changes.themeMode ||
    changes.fontScale ||
    changes.highContrast ||
    changes.reducedMotion
  )
    void broadcastAccessibilitySettings();
  if (
    changes.enabled ||
    changes.focusGoal ||
    changes.similarityThreshold ||
    changes.allowDomains ||
    changes.blockDomains
  ) {
    if (isFocusModeActive()) void warmLocalModel();
    void broadcastPageScan();
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  oneTimeBypassByTab.delete(tabId);
  blockingTabs.delete(tabId);
  void chrome.storage.session.remove(`${BLOCKED_CONTEXT_PREFIX}${tabId}`);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void handleTabUpdated(tabId, changeInfo, tab);
});
chrome.webNavigation.onCommitted.addListener((details) => {
  void handleNavigation(details);
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  void handleNavigation(details);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "focuify-text-ranking") return false;
  const type = String(message?.type || "");
  if (type === "ANALYZE_PAGE") {
    void handleAnalyzeMessage(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) }),
      );
    return true;
  }
  if (type === "GET_SETTINGS") {
    void initPromise.then(() =>
      sendResponse({
        ok: true,
        settings: { ...settings },
      }),
    );
    return true;
  }
  if (type === "SAVE_SETTINGS") {
    void saveSettings(message?.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) }),
      );
    return true;
  }
  if (type === "GET_ACCESSIBILITY_SETTINGS") {
    void initPromise.then(() =>
      sendResponse({ ok: true, settings: publicAccessibilitySettings() }),
    );
    return true;
  }
  if (type === "GET_BLOCK_CONTEXT") {
    if (!isBlockedPageSender(sender)) return false;
    void getBlockedContext(sender?.tab?.id).then((context) =>
      sendResponse({
        ok: Boolean(context),
        context: publicBlockedContext(context),
      }),
    );
    return true;
  }
  if (type === "ALLOW_ONCE_OPEN") {
    if (!isBlockedPageSender(sender)) return false;
    void allowOnceOpen(sender?.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) }),
      );
    return true;
  }
  if (type === "ALLOW_DOMAIN_AND_OPEN") {
    if (!isBlockedPageSender(sender)) return false;
    void allowDomainOpen(sender?.tab?.id)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) }),
      );
    return true;
  }
  return false;
});

async function init() {
  if (isReady) return;
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  await chrome.storage.session.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  await hydrateSettings();
  isReady = true;
  if (isFocusModeActive()) void warmLocalModel();
}

async function hydrateSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  settings = sanitizeSettings(stored);
  await chrome.storage.local.set(settings);
  const currentKeys = new Set(Object.keys(DEFAULT_SETTINGS));
  const unusedKeys = Object.keys(await chrome.storage.local.get(null)).filter(
    (key) => !currentKeys.has(key),
  );
  if (unusedKeys.length) await chrome.storage.local.remove(unusedKeys);
}

async function saveSettings(payload) {
  await initPromise;
  const next = sanitizeSettings({ ...settings, ...(payload || {}) });
  const shouldWarm =
    next.enabled &&
    next.focusGoal &&
    (!settings.enabled || next.focusGoal !== settings.focusGoal);
  settings = next;
  clearDecisionCache();
  await chrome.storage.local.set(next);
  if (shouldWarm) void warmLocalModel();
  return {
    settings: { ...settings },
  };
}

async function handleTabUpdated(tabId, changeInfo, tab) {
  await initPromise;
  const url =
    typeof changeInfo?.url === "string" && changeInfo.url
      ? changeInfo.url
      : String(tab?.url || "");
  if (!isHttpUrl(url)) return;
  const blocked = await maybeBlockByDomain(tabId, url);
  if (!blocked && changeInfo?.status === "complete")
    await ensurePageScanner(tabId);
}

async function handleNavigation(details) {
  await initPromise;
  if (!details || details.frameId !== 0) return;
  const url = String(details.url || "");
  if (!isHttpUrl(url)) return;
  await maybeBlockByDomain(Number(details.tabId), url);
}

async function ensurePageScanner(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "FOCUIFY_SCAN_NOW" });
  } catch {
    await chrome.scripting
      .executeScript({ target: { tabId }, files: ["content_script.js"] })
      .catch(() => {});
  }
}

async function handleAnalyzeMessage(message, sender) {
  await initPromise;
  const tabId = sender?.tab?.id;
  const payload = message?.payload;
  if (!Number.isFinite(tabId) || !payload || !isFocusModeActive()) return;
  const rawUrl = String(payload.url || "");
  if (!isHttpUrl(rawUrl)) return;
  const host = normalizeDomain(new URL(rawUrl).hostname);
  if (!host || hostMatchesAny(host, settings.allowDomains)) return;
  if (hasValidOneTimeBypass(tabId, host)) return;
  if (hostMatchesAny(host, settings.blockDomains)) {
    await blockTab(tabId, {
      url: rawUrl,
      domain: host,
      similarity: 0,
      reason: "Manually blocked domain",
    });
    return;
  }

  const evidence = compactPageEvidence(payload);
  if (!evidence) return;
  const threshold = settings.similarityThreshold;
  try {
    const score = await scoreRelevance(settings.focusGoal, evidence);
    if (score < threshold) {
      await blockTab(tabId, {
        url: rawUrl,
        domain: host,
        similarity: score,
        reason: "This page does not match your focus goal.",
      });
    }
  } catch {}
}

async function scoreRelevance(goal, evidence) {
  const goalText = sanitizeText(goal, 360);
  const cacheKey = hashString(`${goalText}\n${evidence.compact}`);
  const cached = decisionCache.get(cacheKey);
  if (cached && Date.now() - cached.time < DECISION_CACHE_TTL_MS)
    return cached.score;
  const documents = rankingDocuments(evidence);
  if (!documents.length)
    throw new Error("This page did not provide usable relevance evidence.");
  const scores = await requestTextRanking(goalText, documents);
  const score = Math.max(...scores);
  if (!Number.isFinite(score))
    throw new Error("The local relevance model returned no score.");
  rememberDecision(cacheKey, score);
  return score;
}

async function warmLocalModel() {
  if (modelWarmPromise) return modelWarmPromise;
  modelWarmPromise = requestTextRanking("study the assigned lesson", [
    "Assigned lesson study material.",
  ])
    .catch(() => [])
    .finally(() => {
      modelWarmPromise = null;
    });
  return modelWarmPromise;
}

async function maybeBlockByDomain(tabId, rawUrl) {
  if (!isFocusModeActive() || !isHttpUrl(rawUrl)) return false;
  const host = normalizeDomain(new URL(rawUrl).hostname);
  if (
    !host ||
    hostMatchesAny(host, settings.allowDomains) ||
    hasValidOneTimeBypass(tabId, host)
  )
    return false;
  if (!hostMatchesAny(host, settings.blockDomains)) return false;
  return blockTab(tabId, {
    url: rawUrl,
    domain: host,
    similarity: 0,
    reason: "Manually blocked domain",
  });
}

async function blockTab(tabId, context) {
  if (blockingTabs.has(tabId)) return false;
  blockingTabs.add(tabId);
  try {
    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (
      !current ||
      String(current.url || "").startsWith(
        chrome.runtime.getURL("blocked.html"),
      )
    )
      return false;
    await chrome.storage.session.set({
      [`${BLOCKED_CONTEXT_PREFIX}${tabId}`]: {
        url: context.url,
        domain: context.domain,
        score: Number(context.similarity || 0).toFixed(3),
        threshold: Number(settings.similarityThreshold).toFixed(3),
        goal: settings.focusGoal,
        reason:
          context.reason || "This page does not match your active focus goal.",
      },
    });
    await chrome.tabs.update(tabId, {
      url: chrome.runtime.getURL("blocked.html"),
    });
    return true;
  } finally {
    blockingTabs.delete(tabId);
  }
}

async function getBlockedContext(tabId) {
  if (!Number.isFinite(tabId)) return null;
  const key = `${BLOCKED_CONTEXT_PREFIX}${tabId}`;
  return (await chrome.storage.session.get({ [key]: null }))[key];
}

function publicBlockedContext(context) {
  if (!context) return null;
  return {
    domain: context.domain,
    score: context.score,
    threshold: context.threshold,
    goal: context.goal,
    reason: context.reason,
  };
}

function isBlockedPageSender(sender) {
  return (
    Number.isFinite(sender?.tab?.id) &&
    sender?.url === chrome.runtime.getURL("blocked.html")
  );
}

async function consumeBlockedContext(tabId) {
  const context = await getBlockedContext(tabId);
  if (!context?.url)
    throw new Error("This blocked page has expired. Go back and try again.");
  await chrome.storage.session.remove(`${BLOCKED_CONTEXT_PREFIX}${tabId}`);
  return context;
}

async function allowOnceOpen(tabId) {
  await initPromise;
  const context = await consumeBlockedContext(tabId);
  const host = normalizeDomain(new URL(context.url).hostname);
  oneTimeBypassByTab.set(tabId, {
    domain: host,
    expiresAt: Date.now() + ONE_TIME_BYPASS_TTL_MS,
  });
  await chrome.tabs.update(tabId, { url: context.url });
}

async function allowDomainOpen(tabId) {
  await initPromise;
  const context = await consumeBlockedContext(tabId);
  const host = normalizeDomain(new URL(context.url).hostname);
  settings = sanitizeSettings({
    ...settings,
    allowDomains: [...settings.allowDomains, host],
  });
  await chrome.storage.local.set({ allowDomains: settings.allowDomains });
  await chrome.tabs.update(tabId, { url: context.url });
}

function publicAccessibilitySettings() {
  return {
    themeMode: settings.themeMode,
    fontScale: settings.fontScale,
    highContrast: settings.highContrast,
    reducedMotion: settings.reducedMotion,
  };
}

async function broadcastAccessibilitySettings() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(
    tabs.map((tab) =>
      Number.isFinite(tab.id)
        ? chrome.tabs
            .sendMessage(tab.id, {
              type: "FOCUIFY_ACCESSIBILITY_CHANGED",
              settings: publicAccessibilitySettings(),
            })
            .catch(() => {})
        : Promise.resolve(),
    ),
  );
}

async function broadcastPageScan() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(
    tabs.map((tab) =>
      Number.isFinite(tab.id)
        ? chrome.tabs
            .sendMessage(tab.id, { type: "FOCUIFY_SCAN_NOW" })
            .catch(() => {})
        : Promise.resolve(),
    ),
  );
}

function isFocusModeActive() {
  return Boolean(settings.enabled && settings.focusGoal);
}
function clearDecisionCache() {
  decisionCache.clear();
}
function rememberDecision(key, score) {
  decisionCache.set(key, { score, time: Date.now() });
  while (decisionCache.size > DECISION_CACHE_MAX)
    decisionCache.delete(decisionCache.keys().next().value);
}
function hasValidOneTimeBypass(tabId, host) {
  const entry = oneTimeBypassByTab.get(tabId);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    oneTimeBypassByTab.delete(tabId);
    return false;
  }
  return domainMatches(host, entry.domain);
}
function hostMatchesAny(host, domains) {
  return (Array.isArray(domains) ? domains : []).some((domain) =>
    domainMatches(host, domain),
  );
}
function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}
function normalizeDomain(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0]
    .replace(/^www\./, "")
    .trim();
}
function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}
function uniqueDomains(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map(normalizeDomain)
        .filter((value) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)),
    ),
  ].slice(0, 80);
}
function sanitizeSettings(next) {
  const goal = sanitizeText(next?.focusGoal, 220);
  return {
    enabled: Boolean(next?.enabled),
    focusGoal: goal,
    similarityThreshold: clamp(
      Number(next?.similarityThreshold) || DEFAULT_SIMILARITY_THRESHOLD,
      0.1,
      0.9,
    ),
    allowDomains: uniqueDomains(next?.allowDomains),
    blockDomains: uniqueDomains(next?.blockDomains),
    themeMode: sanitizeThemeMode(next?.themeMode),
    fontScale: clamp(Number(next?.fontScale) || 1, 0.85, 1.25),
    highContrast: Boolean(next?.highContrast),
    reducedMotion: Boolean(next?.reducedMotion),
  };
}
function sanitizeThemeMode(value) {
  return ["light", "dark", "zen"].includes(String(value || "").toLowerCase())
    ? String(value).toLowerCase()
    : "light";
}
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}
