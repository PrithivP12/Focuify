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
  if (!response?.ok) {
    setStatus(statusText, response?.error || "Could not load settings.", true);
    return;
  }
  applySettings(response.settings || {});
  $("modelInfo").textContent = "Private on-device matching";
}

function applySettings(settings) {
  enabled.checked = Boolean(settings.enabled);
  focusGoal.value = String(settings.focusGoal || "");
  threshold.value = String(Number(settings.similarityThreshold) || 0.5);
  allowDomains.value = (settings.allowDomains || []).join("\n");
  blockDomains.value = (settings.blockDomains || []).join("\n");
  themeMode.value = settings.themeMode || "light";
  fontScale.value = String(Number(settings.fontScale) || 1);
  highContrast.checked = Boolean(settings.highContrast);
  reducedMotion.checked = Boolean(settings.reducedMotion);
  renderAccessibility();
  renderFocusState();
}

function collectSettings() {
  return {
    enabled: enabled.checked,
    focusGoal: focusGoal.value.trim().slice(0, 220),
    similarityThreshold: Number(threshold.value) || 0.5,
    allowDomains: parseDomains(allowDomains.value),
    blockDomains: parseDomains(blockDomains.value),
    themeMode: themeMode.value,
    fontScale: Number(fontScale.value) || 1,
    highContrast: highContrast.checked,
    reducedMotion: reducedMotion.checked,
  };
}

async function save(target = statusText, automatic = false) {
  const value = collectSettings();
  if (!value.focusGoal) {
    enabled.checked = false;
    value.enabled = false;
  }
  setStatus(target, "Saving…");
  const response = await sendMessage({ type: "SAVE_SETTINGS", payload: value });
  if (!response?.ok) {
    if (automatic) settingsDirty = true;
    setStatus(target, response?.error || "Could not save settings.", true);
    return;
  }
  if (!automatic) applySettings(response.settings || value);
  setStatus(target, automatic ? "Saved automatically." : "Settings saved.");
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
  thresholdValue.textContent = thresholdLabel(Number(threshold.value));
}

function renderFocusState() {
  const active = Boolean(enabled.checked && focusGoal.value.trim());
  $("focusModePill").textContent = active ? "Active" : "Off";
  $("focusModePill").classList.toggle("active", active);
  $("focusStateTitle").textContent = active
    ? "You’re in focus mode"
    : "Choose your focus";
  $("focusStateCopy").textContent = active
    ? "Pages are being checked against your goal."
    : "Set one clear goal so Focuify knows what belongs in this session.";
  $("saveButton").textContent = active
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

$("focusTab").addEventListener("click", () => switchView("focus"));
$("settingsTab").addEventListener("click", () => switchView("settings"));
$("saveButton").addEventListener("click", () => void save());
for (const input of [
  themeMode,
  fontScale,
  highContrast,
  reducedMotion,
  threshold,
]) {
  input.addEventListener("input", () => {
    renderAccessibility();
    scheduleSettingsSave();
  });
}
for (const input of [allowDomains, blockDomains])
  input.addEventListener("input", scheduleSettingsSave);
for (const input of [enabled, focusGoal])
  input.addEventListener("input", renderFocusState);
window.addEventListener("pagehide", flushSettings);
void load();
