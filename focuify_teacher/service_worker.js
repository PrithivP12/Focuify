import { requestTextRanking } from "./local-model/client.js";
import {
  compactPageEvidence,
  extractKeywords,
  extractSearchQuery,
  rankingDocuments,
  sanitizeText,
} from "./keywordUtils.js";

const RUNTIME_MODEL_ID = "mxbai-rerank-xsmall-v1-base-q8";
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;
const SETTINGS_SCHEMA_VERSION = 2;
const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  focusGoal: "",
  similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
  searchGuardEnabled: false,
  allowDomains: [],
  blockDomains: [],
  themeMode: "light",
  fontScale: 1,
  highContrast: false,
  reducedMotion: false,
});

const DECISION_CACHE_TTL_MS = 15 * 60 * 1000;
const DECISION_CACHE_MAX = 800;
const SEARCH_DECISION_TTL_MS = 3 * 1000;
const ONE_TIME_BYPASS_TTL_MS = 10 * 60 * 1000;
const DEFAULT_API_BASE_URL = "http://localhost:8787";
const CLASS_POLICY_TTL_MS = 60 * 1000;
const CLASS_SESSION_STORAGE_KEY = "classSession";
const DEVICE_ID_STORAGE_KEY = "focuifyDeviceId";
const LEGACY_DEVICE_ID_STORAGE_KEY = "focusforgeDeviceId";
const PRE_CLASS_SETTINGS_STORAGE_KEY = "preClassSettings";
const BLOCKED_CONTEXT_PREFIX = "blockedContext:";
const OBSOLETE_STORAGE_KEYS = [
  "focusGoals",
  "activeGoalIndex",
  "quizDefaultDifficulty",
  "quizDefaultFormat",
  "thresholdProfile",
  "thresholdAutoRampEnabled",
  "thresholdRampStepMinutes",
  "thresholdRampDelta",
  "thresholdRampMaxDelta",
  "scheduleEnabled",
  "scheduleStart",
  "scheduleEnd",
  "scheduleWeekdays",
  "categoryBlockingEnabled",
  "blockedCategories",
  "categoryAllowOnHighRelevance",
  "pomodoroEnabled",
  "pomodoroWorkMinutes",
  "pomodoroBreakMinutes",
  "pomodoroLongBreakMinutes",
  "pomodoroLongBreakEvery",
  "pomodoroAutoStartBreak",
  "pomodoroAutoStartWork",
  "pomodoroState",
  "blockUntilTasksDone",
  "tasks",
  "integrationHooksEnabled",
  "integrationAllowDomains",
  "reminderSnoozeUntil",
  "reminderFrequencyMinutes",
  "reminderOffTrackEnabled",
  "reminderWinEnabled",
  "syncEnabled",
  "notificationsEnabled",
  "adBlockEnabled",
  "cosmeticAdBlockEnabled",
  "adBlockState",
  "adBlockLiveState",
  "focusStats",
  "decisionLog",
  "ff_turns",
  "ff_summary",
  "modelFallbackEnabled",
  "embeddingModelId",
  "embeddingBackendPreference",
];
const MODEL_RUNTIME_STATS_DEFAULT = Object.freeze({
  modelVersion: "not-loaded",
  loadDurationMs: 0,
  inferenceCount: 0,
  avgInferenceMs: 0,
});

let settings = { ...DEFAULT_SETTINGS };
let modelRuntimeStats = { ...MODEL_RUNTIME_STATS_DEFAULT };
let modelWarmPromise = null;
let policySyncPromise = null;
let lastModelError = "";
let isReady = false;
let classSession = null;
let preClassSettings = null;
let lastReportedStatus = "";
let lastStatusReportedAt = 0;
const decisionCache = new Map();
const oneTimeBypassByTab = new Map();
const searchDecisionByTab = new Map();
const blockingTabs = new Set();
const initPromise = init();

chrome.runtime.onInstalled.addListener(() => {
  void hydrateSettings(true);
});
chrome.runtime.onStartup.addListener(() => {
  void hydrateSettings(false);
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.modelRuntimeStats) {
    modelRuntimeStats = sanitizeModelRuntimeStats(
      changes.modelRuntimeStats.newValue,
    );
  }
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
  searchDecisionByTab.delete(tabId);
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
        enrollment: publicClassSession(),
        classManaged: Boolean(classSession),
        runtimeModelId: RUNTIME_MODEL_ID,
        modelRuntimeStats: { ...modelRuntimeStats },
        lastModelError,
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
  if (type === "JOIN_CLASS") {
    void joinClass(message?.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) }),
      );
    return true;
  }
  if (type === "LEAVE_CLASS") {
    void leaveClass()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error?.message || error) }),
      );
    return true;
  }
  if (type === "SYNC_CLASS_POLICY") {
    void syncClassPolicy(true)
      .then(() =>
        sendResponse({
          ok: true,
          settings: { ...settings },
          enrollment: publicClassSession(),
        }),
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error?.message || error),
          settings: { ...settings },
          enrollment: publicClassSession(),
        }),
      );
    return true;
  }
  if (type === "GET_ACCESSIBILITY_SETTINGS") {
    void initPromise.then(() =>
      sendResponse({ ok: true, settings: publicAccessibilitySettings() }),
    );
    return true;
  }
  if (type === "FOCUIFY_HEARTBEAT") {
    void heartbeatClass()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
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
  await hydrateSettings(false);
  isReady = true;
  if (isFocusModeActive()) void warmLocalModel();
  if (classSession) void syncClassPolicy(false);
}

async function hydrateSettings(seedDefaults) {
  const stored = await chrome.storage.local.get({
    ...DEFAULT_SETTINGS,
    settingsSchemaVersion: 0,
  });
  const migrateLegacyThreshold =
    Number(stored.settingsSchemaVersion) < SETTINGS_SCHEMA_VERSION &&
    Number(stored.similarityThreshold) === 0.35;
  settings = sanitizeSettings({
    ...stored,
    similarityThreshold: migrateLegacyThreshold
      ? DEFAULT_SIMILARITY_THRESHOLD
      : stored.similarityThreshold,
  });
  const classStored = await chrome.storage.local.get({
    [CLASS_SESSION_STORAGE_KEY]: null,
    [PRE_CLASS_SETTINGS_STORAGE_KEY]: null,
  });
  classSession = sanitizeClassSession(classStored[CLASS_SESSION_STORAGE_KEY]);
  preClassSettings = sanitizePreClassSettings(
    classStored[PRE_CLASS_SETTINGS_STORAGE_KEY],
  );
  if (
    migrateLegacyThreshold &&
    classSession?.policy?.similarityThreshold === 0.35
  ) {
    classSession = sanitizeClassSession({
      ...classSession,
      policy: {
        ...classSession.policy,
        similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
      },
    });
  }
  if (
    migrateLegacyThreshold &&
    preClassSettings?.similarityThreshold === 0.35
  ) {
    preClassSettings = sanitizePreClassSettings({
      ...preClassSettings,
      similarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
    });
  }
  modelRuntimeStats = sanitizeModelRuntimeStats(
    (
      await chrome.storage.local.get({
        modelRuntimeStats: MODEL_RUNTIME_STATS_DEFAULT,
      })
    ).modelRuntimeStats,
  );
  if (seedDefaults || migrateLegacyThreshold)
    await chrome.storage.local.set({
      ...settings,
      settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
      modelRuntimeStats,
      ...(classSession ? { [CLASS_SESSION_STORAGE_KEY]: classSession } : {}),
      ...(preClassSettings
        ? { [PRE_CLASS_SETTINGS_STORAGE_KEY]: preClassSettings }
        : {}),
    });
  await chrome.storage.local.remove(OBSOLETE_STORAGE_KEYS);
}

async function saveSettings(payload) {
  await initPromise;
  const requested = payload || {};
  const managedPatch = classSession
    ? {
        ...requested,
        enabled: settings.enabled,
        focusGoal: settings.focusGoal,
        similarityThreshold: settings.similarityThreshold,
        searchGuardEnabled: settings.searchGuardEnabled,
        allowDomains: settings.allowDomains,
        blockDomains: settings.blockDomains,
      }
    : requested;
  const next = sanitizeSettings({ ...settings, ...managedPatch });
  const shouldWarm =
    next.enabled &&
    next.focusGoal &&
    (!settings.enabled || next.focusGoal !== settings.focusGoal);
  settings = next;
  clearDecisionCache();
  await chrome.storage.local.set({
    ...next,
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
  });
  if (shouldWarm) void warmLocalModel();
  return {
    settings: { ...settings },
    enrollment: publicClassSession(),
    classManaged: Boolean(classSession),
    modelRuntimeStats: { ...modelRuntimeStats },
  };
}

async function joinClass(payload) {
  await initPromise;
  const previousSession = classSession;
  const apiBaseUrl = normalizeApiBaseUrl(
    payload?.apiBaseUrl || DEFAULT_API_BASE_URL,
  );
  const classCode = String(payload?.classCode || "")
    .trim()
    .toUpperCase();
  const studentName = sanitizeText(payload?.studentName, 80)
    .replace(/\s+/g, " ")
    .trim();
  if (!apiBaseUrl)
    throw new Error(
      "Enter a valid API URL (for example, http://localhost:8787).",
    );
  if (!/^[A-Z2-9]{6}$/.test(classCode))
    throw new Error("Class codes are six letters or numbers.");
  if (studentName.length < 2)
    throw new Error("Enter a name your teacher will recognize.");
  const deviceId = await getDeviceId();
  const result = await fetchFocusApi(`${apiBaseUrl}/v1/join`, {
    method: "POST",
    body: JSON.stringify({ classCode, name: studentName, deviceId }),
  });
  if (!preClassSettings) {
    preClassSettings = {
      enabled: settings.enabled,
      focusGoal: settings.focusGoal,
      similarityThreshold: settings.similarityThreshold,
      searchGuardEnabled: settings.searchGuardEnabled,
      allowDomains: settings.allowDomains,
      blockDomains: settings.blockDomains,
    };
  }
  const policy = sanitizeTeacherPolicy(result?.class?.policy);
  classSession = sanitizeClassSession({
    apiBaseUrl,
    token: String(result.token || ""),
    studentId: result?.student?.id,
    studentName: result?.student?.name || studentName,
    classId: result?.class?.id,
    className: result?.class?.name,
    classCode: result?.class?.classCode || classCode,
    policy,
    lastPolicyAt: Date.now(),
    joinedAt: new Date().toISOString(),
    lastError: "",
  });
  if (
    !classSession?.token ||
    !classSession?.studentId ||
    !classSession?.classId
  )
    throw new Error("The class server returned an incomplete enrollment.");
  await applyTeacherPolicy(policy);
  if (
    previousSession?.token &&
    (previousSession.classId !== classSession.classId ||
      previousSession.apiBaseUrl !== classSession.apiBaseUrl)
  ) {
    void fetchFocusApi(
      `${previousSession.apiBaseUrl}/v1/student/leave`,
      { method: "POST" },
      previousSession.token,
    ).catch(() => {});
  }
  await chrome.storage.local.set({
    [CLASS_SESSION_STORAGE_KEY]: classSession,
    [PRE_CLASS_SETTINGS_STORAGE_KEY]: preClassSettings,
  });
  return {
    settings: { ...settings },
    enrollment: publicClassSession(),
    classManaged: true,
  };
}

async function leaveClass() {
  await initPromise;
  let warning = "";
  if (classSession?.token) {
    try {
      await fetchFocusApi(
        `${classSession.apiBaseUrl}/v1/student/leave`,
        { method: "POST" },
        classSession.token,
      );
    } catch {
      warning = `Local access restored. The server will mark this device offline when it next connects.`;
    }
  }
  await clearClassSession();
  return {
    settings: { ...settings },
    enrollment: null,
    classManaged: false,
    warning,
  };
}

async function clearClassSession() {
  settings = sanitizeSettings({ ...settings, ...(preClassSettings || {}) });
  classSession = null;
  preClassSettings = null;
  lastReportedStatus = "";
  lastStatusReportedAt = 0;
  clearDecisionCache();
  await chrome.storage.local.set({ ...settings });
  await chrome.storage.local.remove([
    CLASS_SESSION_STORAGE_KEY,
    PRE_CLASS_SETTINGS_STORAGE_KEY,
  ]);
}

async function maybeSyncClassPolicy() {
  if (!classSession) return;
  if (Date.now() - Number(classSession.lastPolicyAt || 0) < CLASS_POLICY_TTL_MS)
    return;
  await syncClassPolicy(false);
}

async function syncClassPolicy(force) {
  await initPromise;
  if (!classSession?.token) return;
  if (
    !force &&
    Date.now() - Number(classSession.lastPolicyAt || 0) < CLASS_POLICY_TTL_MS
  )
    return;
  if (policySyncPromise) return policySyncPromise;
  policySyncPromise = updateClassPolicy(force);
  try {
    return await policySyncPromise;
  } finally {
    policySyncPromise = null;
  }
}

async function updateClassPolicy(force) {
  try {
    const result = await fetchFocusApi(
      `${classSession.apiBaseUrl}/v1/student/policy-sync`,
      {},
      classSession.token,
    );
    const nextPolicy = sanitizeTeacherPolicy(result?.class?.policy);
    classSession = sanitizeClassSession({
      ...classSession,
      classId: result?.class?.id || classSession.classId,
      className: result?.class?.name || classSession.className,
      classCode: result?.class?.classCode || classSession.classCode,
      policy: nextPolicy,
      lastPolicyAt: Date.now(),
      lastError: "",
    });
    await applyTeacherPolicy(nextPolicy);
    await chrome.storage.local.set({
      [CLASS_SESSION_STORAGE_KEY]: classSession,
    });
  } catch (error) {
    if (error?.status === 401 || error?.status === 404) {
      await clearClassSession();
      const accessError = new Error(
        "Your teacher removed this device from the class.",
      );
      if (force) throw accessError;
      return;
    }
    classSession = sanitizeClassSession({
      ...classSession,
      lastError: String(error?.message || error),
    });
    await chrome.storage.local.set({
      [CLASS_SESSION_STORAGE_KEY]: classSession,
    });
    if (force) throw error;
  }
}

async function applyTeacherPolicy(policy) {
  const next = sanitizeSettings({
    ...settings,
    enabled: policy.enabled,
    focusGoal: policy.focusGoal,
    similarityThreshold: policy.similarityThreshold,
    searchGuardEnabled: policy.searchGuardEnabled,
    allowDomains: [],
    blockDomains: [],
  });
  settings = next;
  clearDecisionCache();
  await chrome.storage.local.set({
    enabled: next.enabled,
    focusGoal: next.focusGoal,
    similarityThreshold: next.similarityThreshold,
    searchGuardEnabled: next.searchGuardEnabled,
    allowDomains: [],
    blockDomains: [],
  });
}

function reportStudentStatus(status) {
  if (!classSession?.token || !["focused", "blocked"].includes(status)) return;
  const timestamp = Date.now();
  if (
    status === "focused" &&
    status === lastReportedStatus &&
    timestamp - lastStatusReportedAt < 30_000
  )
    return;
  lastReportedStatus = status;
  lastStatusReportedAt = timestamp;
  void fetchFocusApi(
    `${classSession.apiBaseUrl}/v1/student/status`,
    {
      method: "POST",
      body: JSON.stringify({ status }),
    },
    classSession.token,
  ).catch(() => {});
}

async function heartbeatClass() {
  await initPromise;
  if (!classSession?.token) return;
  await fetchFocusApi(
    `${classSession.apiBaseUrl}/v1/student/heartbeat`,
    { method: "POST" },
    classSession.token,
  );
}

async function getDeviceId() {
  const stored = await chrome.storage.local.get({
    [DEVICE_ID_STORAGE_KEY]: "",
    [LEGACY_DEVICE_ID_STORAGE_KEY]: "",
  });
  const existing = String(
    stored[DEVICE_ID_STORAGE_KEY] || stored[LEGACY_DEVICE_ID_STORAGE_KEY] || "",
  );
  if (/^[a-zA-Z0-9._:-]{12,120}$/.test(existing)) {
    if (!stored[DEVICE_ID_STORAGE_KEY]) {
      await chrome.storage.local.set({ [DEVICE_ID_STORAGE_KEY]: existing });
      await chrome.storage.local.remove(LEGACY_DEVICE_ID_STORAGE_KEY);
    }
    return existing;
  }
  const generated = `focuify-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  await chrome.storage.local.set({ [DEVICE_ID_STORAGE_KEY]: generated });
  return generated;
}

async function fetchFocusApi(url, options = {}, token = "") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new FocusApiError(
        response.status,
        data?.error?.message || `Server request failed (${response.status}).`,
      );
    return data;
  } catch (error) {
    if (error?.name === "AbortError")
      throw new Error("The class server did not respond in time.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeApiBaseUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (
      !/^https?:$/.test(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      return "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function sanitizeClassSession(value) {
  if (!value || typeof value !== "object") return null;
  const apiBaseUrl = normalizeApiBaseUrl(value.apiBaseUrl);
  const token = String(value.token || "");
  const studentId = String(value.studentId || "");
  const classId = String(value.classId || "");
  if (!apiBaseUrl || !token || !studentId || !classId) return null;
  return {
    apiBaseUrl,
    token,
    studentId,
    studentName: sanitizeText(value.studentName, 80),
    classId,
    className: sanitizeText(value.className, 100),
    classCode: String(value.classCode || "")
      .toUpperCase()
      .slice(0, 6),
    policy: sanitizeTeacherPolicy(value.policy),
    lastPolicyAt: Math.max(0, Number(value.lastPolicyAt) || 0),
    joinedAt: String(value.joinedAt || ""),
    lastError: sanitizeText(value.lastError, 240),
  };
}

function publicClassSession() {
  if (!classSession) return null;
  return {
    apiBaseUrl: classSession.apiBaseUrl || DEFAULT_API_BASE_URL,
    studentId: classSession.studentId,
    studentName: classSession.studentName,
    classId: classSession.classId,
    className: classSession.className,
    classCode: classSession.classCode,
    policy: classSession.policy,
    lastPolicyAt: classSession.lastPolicyAt,
    joinedAt: classSession.joinedAt,
    lastError: classSession.lastError,
  };
}

function sanitizePreClassSettings(value) {
  if (!value || typeof value !== "object") return null;
  return {
    enabled: Boolean(value.enabled),
    focusGoal: sanitizeText(value.focusGoal, 220),
    similarityThreshold: clamp(
      Number(value.similarityThreshold) || DEFAULT_SIMILARITY_THRESHOLD,
      0.1,
      0.9,
    ),
    searchGuardEnabled: Boolean(value.searchGuardEnabled),
    allowDomains: uniqueDomains(
      Array.isArray(value.allowDomains)
        ? value.allowDomains
        : settings.allowDomains,
    ),
    blockDomains: uniqueDomains(
      Array.isArray(value.blockDomains)
        ? value.blockDomains
        : settings.blockDomains,
    ),
  };
}

function sanitizeTeacherPolicy(value) {
  return {
    enabled: Boolean(value?.enabled),
    focusGoal: sanitizeText(value?.focusGoal, 220),
    similarityThreshold: clamp(
      Number(value?.similarityThreshold) || DEFAULT_SIMILARITY_THRESHOLD,
      0.1,
      0.9,
    ),
    searchGuardEnabled: Boolean(value?.searchGuardEnabled),
    version: Math.max(1, Number(value?.version) || 1),
    updatedAt: String(value?.updatedAt || ""),
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
  if (classSession) await syncClassPolicy(true);
  const tabId = Number(details.tabId);
  if (await maybeBlockSearchQuery(tabId, url)) return;
  await maybeBlockByDomain(tabId, url);
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
  await maybeSyncClassPolicy();
  const tabId = sender?.tab?.id;
  const payload = message?.payload;
  if (!Number.isFinite(tabId) || !payload || !isFocusModeActive()) return;
  const rawUrl = String(payload.url || "");
  if (!isHttpUrl(rawUrl)) return;
  if (classSession && extractSearchQuery(rawUrl)) return;
  const host = normalizeDomain(new URL(rawUrl).hostname);
  if (
    !host ||
    isClassServerHost(host) ||
    hostMatchesAny(host, settings.allowDomains)
  )
    return;
  if (hasValidOneTimeBypass(tabId, host)) return;
  if (hostMatchesAny(host, settings.blockDomains)) {
    const blocked = await blockTab(tabId, {
      url: rawUrl,
      domain: host,
      similarity: 0,
      reason: "Manually blocked domain",
    });
    if (blocked) reportStudentStatus("blocked");
    return;
  }

  const evidence = compactPageEvidence(payload);
  if (!evidence) return;
  const threshold = settings.similarityThreshold;
  try {
    const score = await scoreRelevance(settings.focusGoal, evidence);
    if (score < threshold) {
      const blocked = await blockTab(tabId, {
        url: rawUrl,
        domain: host,
        similarity: score,
        reason: "This page does not match your focus goal.",
      });
      if (blocked) reportStudentStatus("blocked");
    } else {
      reportStudentStatus("focused");
    }
  } catch (error) {
    lastModelError = String(error?.message || error);
    if (classSession) {
      const blocked = await blockTab(tabId, {
        url: rawUrl,
        domain: host,
        similarity: 0,
        reason:
          "Focuify could not load its local relevance model. This page is blocked until the model is ready.",
      });
      if (blocked) reportStudentStatus("blocked");
    }
  }
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
  const result = await requestTextRanking(goalText, documents);
  const score = Math.max(...result.scores);
  if (!Number.isFinite(score))
    throw new Error("The local relevance model returned no score.");
  noteInference(result);
  rememberDecision(cacheKey, score);
  return score;
}

async function maybeBlockSearchQuery(tabId, rawUrl) {
  const query = extractSearchQuery(rawUrl);
  if (
    !query ||
    !classSession ||
    !settings.searchGuardEnabled ||
    !isFocusModeActive()
  )
    return false;
  const host = normalizeDomain(new URL(rawUrl).hostname);
  if (hasValidOneTimeBypass(tabId, host)) return false;
  const decisionKey = `${query}\n${settings.focusGoal}\n${settings.similarityThreshold}`;
  const previous = searchDecisionByTab.get(tabId);
  if (
    previous?.key === decisionKey &&
    Date.now() - previous.time < SEARCH_DECISION_TTL_MS
  )
    return previous.promise;
  const promise = evaluateSearchQuery(tabId, rawUrl, host, query);
  searchDecisionByTab.set(tabId, {
    key: decisionKey,
    time: Date.now(),
    promise,
  });
  return promise;
}

async function evaluateSearchQuery(tabId, rawUrl, host, query) {
  const evidence = compactPageEvidence({
    sourceType: "search",
    title: query,
    headings: [],
    keywords: extractKeywords(query),
    text: query,
  });
  const threshold = settings.similarityThreshold;
  let score;
  let reason = "This Google search does not match your class focus goal.";
  try {
    score = await scoreRelevance(settings.focusGoal, evidence);
  } catch (error) {
    lastModelError = String(error?.message || error);
    score = 0;
    reason =
      "Focuify could not load its local relevance model. This search is blocked until the model is ready.";
  }
  const action = score < threshold ? "blocked" : "allowed";
  if (action === "blocked") {
    const blocked = await blockTab(tabId, {
      url: rawUrl,
      domain: host,
      similarity: score,
      reason,
    });
    if (!blocked) return false;
  }
  reportStudentStatus(action === "allowed" ? "focused" : "blocked");
  return action === "blocked";
}

async function warmLocalModel() {
  if (modelWarmPromise) return modelWarmPromise;
  modelWarmPromise = requestTextRanking("study the assigned lesson", [
    "Assigned lesson study material.",
  ])
    .then((result) => {
      noteInference(result);
      lastModelError = "";
      return result;
    })
    .catch((error) => {
      lastModelError = String(error?.message || error);
      throw error;
    })
    .finally(() => {
      modelWarmPromise = null;
    });
  return modelWarmPromise;
}

function noteInference(result) {
  const count = Math.max(0, Number(modelRuntimeStats.inferenceCount) || 0) + 1;
  const durationMs = Math.max(0, Number(result?.durationMs) || 0);
  const average =
    ((Number(modelRuntimeStats.avgInferenceMs) || 0) * (count - 1) +
      durationMs) /
    count;
  modelRuntimeStats = sanitizeModelRuntimeStats({
    ...modelRuntimeStats,
    modelVersion: String(
      result?.modelVersion || modelRuntimeStats.modelVersion,
    ),
    loadDurationMs: Math.max(
      Number(modelRuntimeStats.loadDurationMs) || 0,
      Number(result?.loadDurationMs) || 0,
    ),
    inferenceCount: count,
    avgInferenceMs: average,
  });
  lastModelError = "";
  void chrome.storage.local.set({ modelRuntimeStats });
}

async function maybeBlockByDomain(tabId, rawUrl) {
  await maybeSyncClassPolicy();
  if (!isFocusModeActive() || !isHttpUrl(rawUrl)) return false;
  const host = normalizeDomain(new URL(rawUrl).hostname);
  if (
    !host ||
    isClassServerHost(host) ||
    hostMatchesAny(host, settings.allowDomains) ||
    hasValidOneTimeBypass(tabId, host)
  )
    return false;
  if (!hostMatchesAny(host, settings.blockDomains)) return false;
  const blocked = await blockTab(tabId, {
    url: rawUrl,
    domain: host,
    similarity: 0,
    reason: "Manually blocked domain",
  });
  if (blocked) reportStudentStatus("blocked");
  return blocked;
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
    classManaged: Boolean(classSession),
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
  if (classSession)
    throw new Error("Your teacher controls this focus session.");
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
  if (classSession)
    throw new Error("Your teacher controls this focus session.");
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
function isClassServerHost(host) {
  if (!classSession?.apiBaseUrl) return false;
  try {
    const apiHost = new URL(classSession.apiBaseUrl).hostname.toLowerCase();
    const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    return (
      host === apiHost || (localHosts.has(host) && localHosts.has(apiHost))
    );
  } catch {
    return false;
  }
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
    searchGuardEnabled: Boolean(next?.searchGuardEnabled),
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
function sanitizeModelRuntimeStats(value) {
  return {
    modelVersion: sanitizeText(
      value?.modelVersion || MODEL_RUNTIME_STATS_DEFAULT.modelVersion,
      80,
    ),
    loadDurationMs: clamp(Number(value?.loadDurationMs) || 0, 0, 3_600_000),
    inferenceCount: clamp(
      Math.floor(Number(value?.inferenceCount) || 0),
      0,
      1_000_000_000,
    ),
    avgInferenceMs: clamp(Number(value?.avgInferenceMs) || 0, 0, 3_600_000),
  };
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

class FocusApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
