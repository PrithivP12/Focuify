const $ = (id) => document.getElementById(id);
const enabled = $("enabled");
const focusGoal = $("focusGoal");
const threshold = $("threshold");
const thresholdValue = $("thresholdValue");
const themeMode = $("themeMode");
const fontScale = $("fontScale");
const fontScaleValue = $("fontScaleValue");
const highContrast = $("highContrast");
const reducedMotion = $("reducedMotion");
const allowDomains = $("allowDomains");
const blockDomains = $("blockDomains");
const statusText = $("statusText");
const settingsStatusText = $("settingsStatusText");
const modelInfo = $("modelInfo");
const focusModePill = $("focusModePill");
const classStatus = $("classStatus");
const classSummaryText = $("classSummaryText");
const classMessage = $("classMessage");
const apiBaseUrl = $("apiBaseUrl");
const classCode = $("classCode");
const studentName = $("studentName");
let classManaged = false;
let enrollment = null;
let settingsDirty = false;
let settingsSaveTimer = 0;

function sendMessage(message) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError)
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response);
    }),
  );
}

async function load() {
  const response = await sendMessage({ type: "GET_SETTINGS" });
  if (!response?.ok)
    return setStatus(
      statusText,
      response?.error || "Could not load settings.",
      true,
    );
  applySettings(
    response.settings || {},
    response.enrollment,
    response.classManaged,
  );
  modelInfo.textContent = "Private on-device matching";
}

function applySettings(
  settings,
  nextEnrollment = enrollment,
  managed = Boolean(nextEnrollment),
) {
  enrollment = nextEnrollment || null;
  classManaged = Boolean(managed || enrollment);
  enabled.checked = Boolean(settings.enabled);
  focusGoal.value = String(settings.focusGoal || "");
  threshold.value = String(Number(settings.similarityThreshold) || 0.5);
  allowDomains.value = (settings.allowDomains || []).join("\n");
  blockDomains.value = (settings.blockDomains || []).join("\n");
  themeMode.value = settings.themeMode || "light";
  fontScale.value = String(Number(settings.fontScale) || 1);
  highContrast.checked = Boolean(settings.highContrast);
  reducedMotion.checked = Boolean(settings.reducedMotion);
  if (enrollment) {
    apiBaseUrl.value =
      enrollment.apiBaseUrl || apiBaseUrl.value || "http://localhost:8787";
    classCode.value = enrollment.classCode || classCode.value || "";
    studentName.value = enrollment.studentName || studentName.value || "";
  }
  renderClassStatus();
  renderManagedFields();
  renderAccessibility();
  renderFocusState();
}

function collectSettings() {
  const value = {
    themeMode: themeMode.value,
    fontScale: Number(fontScale.value) || 1,
    highContrast: highContrast.checked,
    reducedMotion: reducedMotion.checked,
  };
  if (!classManaged) {
    value.enabled = enabled.checked;
    value.focusGoal = focusGoal.value.trim().slice(0, 220);
    value.similarityThreshold = Number(threshold.value) || 0.5;
    value.allowDomains = parseDomains(allowDomains.value);
    value.blockDomains = parseDomains(blockDomains.value);
  }
  return value;
}

async function save(target = statusText, automatic = false) {
  const value = collectSettings();
  if (!classManaged && !value.focusGoal) {
    enabled.checked = false;
    value.enabled = false;
  }
  setStatus(target, "Saving…");
  const response = await sendMessage({ type: "SAVE_SETTINGS", payload: value });
  if (!response?.ok) {
    if (automatic) settingsDirty = true;
    return setStatus(
      target,
      response?.error || "Could not save settings.",
      true,
    );
  }
  if (!automatic)
    applySettings(
      response.settings || value,
      response.enrollment,
      response.classManaged,
    );
  const message = classManaged ? "Display settings saved." : "Settings saved.";
  setStatus(target, automatic ? "Saved automatically." : message);
}

function scheduleSettingsSave() {
  settingsDirty = true;
  setStatus(settingsStatusText, "Saving…");
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(flushSettings, 300);
}

function flushSettings() {
  clearTimeout(settingsSaveTimer);
  if (!settingsDirty) return;
  settingsDirty = false;
  void save(settingsStatusText, true);
}

async function joinClass() {
  setClassMessage("Joining…");
  const response = await sendMessage({
    type: "JOIN_CLASS",
    payload: {
      apiBaseUrl: apiBaseUrl.value.trim(),
      classCode: classCode.value.trim().toUpperCase(),
      studentName: studentName.value.trim(),
    },
  });
  if (!response?.ok)
    return setClassMessage(
      response?.error || "Could not join that class.",
      true,
    );
  applySettings(response.settings || {}, response.enrollment, true);
  setClassMessage(
    `Connected to ${response.enrollment?.className || "your class"}. The teacher policy is active.`,
  );
}

async function leaveClass() {
  setClassMessage("Leaving class…");
  const response = await sendMessage({ type: "LEAVE_CLASS" });
  if (!response?.ok)
    return setClassMessage(
      response?.error || "Could not leave the class.",
      true,
    );
  applySettings(response.settings || {}, null, false);
  setClassMessage(
    response.warning ||
      "You left the class. Your personal settings are restored.",
  );
}

async function syncClass() {
  if (!classManaged)
    return setClassMessage("Join a class before refreshing its policy.", true);
  setClassMessage("Checking for a new teacher policy…");
  const response = await sendMessage({ type: "SYNC_CLASS_POLICY" });
  if (!response?.ok) {
    if (response?.settings)
      applySettings(
        response.settings,
        response.enrollment,
        Boolean(response.enrollment),
      );
    return setClassMessage(
      response?.error ||
        "Could not reach the class server. Cached policy remains active.",
      true,
    );
  }
  applySettings(response.settings || {}, response.enrollment, true);
  setClassMessage("Policy refreshed.");
}

function switchView(name) {
  const showSettings = name === "settings";
  if (!showSettings) flushSettings();
  $("focusView").hidden = showSettings;
  $("settingsView").hidden = !showSettings;
  $("focusTab").classList.toggle("active", !showSettings);
  $("settingsTab").classList.toggle("active", showSettings);
  $("focusTab").setAttribute("aria-selected", String(!showSettings));
  $("settingsTab").setAttribute("aria-selected", String(showSettings));
}

function parseDomains(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/[\n,]+/)
        .map(
          (item) =>
            item
              .trim()
              .toLowerCase()
              .replace(/^https?:\/\//, "")
              .split("/")[0],
        )
        .filter((item) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(item)),
    ),
  ].slice(0, 80);
}

function renderAccessibility() {
  document.body.dataset.theme = themeMode.value;
  document.body.dataset.highContrast = highContrast.checked ? "true" : "false";
  document.body.dataset.reducedMotion = reducedMotion.checked
    ? "true"
    : "false";
  document.documentElement.style.fontSize = `${(Number(fontScale.value) || 1) * 100}%`;
  fontScaleValue.textContent = `${Math.round((Number(fontScale.value) || 1) * 100)}%`;
  thresholdValue.textContent = classManaged
    ? "Teacher managed"
    : thresholdLabel(Number(threshold.value));
}

function renderFocusState() {
  const active = Boolean(enabled.checked && focusGoal.value.trim());
  focusModePill.textContent = active ? "Active" : "Off";
  focusModePill.classList.toggle("active", active);
  $("focusStateTitle").textContent = classManaged
    ? "Class focus"
    : active
      ? "You’re in focus mode"
      : "Choose your focus";
  $("focusStateCopy").textContent = classManaged
    ? `Set by ${enrollment?.className || "your class"}.`
    : active
      ? "Pages are being checked against your goal."
      : "Set one clear goal so Focuify knows what belongs in this session.";
  $("saveButton").textContent = classManaged
    ? "Managed by teacher"
    : active
      ? "Update focus session"
      : "Start focus session";
}

function thresholdLabel(value) {
  return value >= 0.6 ? "Strict" : value <= 0.4 ? "Lenient" : "Balanced";
}
function setStatus(element, text, error = false) {
  element.textContent = text || "";
  element.classList.toggle("error", Boolean(error));
}
function setClassMessage(text, error = false) {
  setStatus(classMessage, text, error);
}

function renderClassStatus() {
  classStatus.classList.toggle("connected", classManaged);
  classSummaryText.textContent = classManaged
    ? `${enrollment?.className || "Connected class"} · ${enrollment?.classCode || ""}`
    : "Connect with a class code";
  classStatus.textContent = classManaged
    ? `Connected to ${enrollment?.className || "your class"}. Focus settings are teacher managed.`
    : "Not connected. A teacher can give you a six-character class code.";
}

function renderManagedFields() {
  for (const input of [
    enabled,
    focusGoal,
    threshold,
    allowDomains,
    blockDomains,
  ])
    input.disabled = classManaged;
  $("saveButton").disabled = classManaged;
  $("managedSettingsNote").hidden = !classManaged;
  $("managedRulesNote").hidden = !classManaged;
}

$("focusTab").addEventListener("click", () => switchView("focus"));
$("settingsTab").addEventListener("click", () => switchView("settings"));
$("saveButton").addEventListener("click", () => void save(statusText));
$("joinClassButton").addEventListener("click", () => void joinClass());
$("leaveClassButton").addEventListener("click", () => void leaveClass());
$("syncClassButton").addEventListener("click", () => void syncClass());
classCode.addEventListener("input", () => {
  classCode.value = classCode.value
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .slice(0, 6);
});
for (const input of [
  themeMode,
  fontScale,
  highContrast,
  reducedMotion,
  threshold,
])
  input.addEventListener("input", () => {
    renderAccessibility();
    scheduleSettingsSave();
  });
for (const input of [allowDomains, blockDomains])
  input.addEventListener("input", scheduleSettingsSave);
for (const input of [enabled, focusGoal])
  input.addEventListener("input", renderFocusState);
window.addEventListener("pagehide", flushSettings);
void load();
