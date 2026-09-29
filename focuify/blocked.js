const summaryText = document.getElementById("summaryText");
const goalText = document.getElementById("goalText");
const domainText = document.getElementById("domainText");
const scoreText = document.getElementById("scoreText");
const thresholdText = document.getElementById("thresholdText");
const openOnceButton = document.getElementById("openOnceButton");
const relevantButton = document.getElementById("relevantButton");
const allowDomainButton = document.getElementById("allowDomainButton");
const goBackButton = document.getElementById("goBackButton");

openOnceButton.disabled = true;
relevantButton.disabled = true;
allowDomainButton.disabled = true;
void loadAccessibility();
void loadContext();

async function loadAccessibility() {
  const response = await sendMessage({ type: "GET_ACCESSIBILITY_SETTINGS" });
  if (!response?.ok) return;
  const settings = response.settings || {};
  document.body.dataset.theme = ["light", "dark", "zen"].includes(
    settings.themeMode,
  )
    ? settings.themeMode
    : "light";
  document.body.dataset.highContrast = settings.highContrast ? "true" : "false";
  document.body.dataset.reducedMotion = settings.reducedMotion
    ? "true"
    : "false";
  document.documentElement.style.fontSize = `${Math.min(1.25, Math.max(0.85, Number(settings.fontScale) || 1)) * 100}%`;
}

async function loadContext() {
  const response = await sendMessage({ type: "GET_BLOCK_CONTEXT" });
  const context = response?.context;
  if (!response?.ok || !context) {
    summaryText.textContent =
      "This blocked-page context expired. Go back and try the page again.";
    return;
  }
  summaryText.textContent =
    context.reason || "This page does not match your active focus goal.";
  goalText.textContent = context.goal || "(not set)";
  domainText.textContent = context.domain || "(unknown)";
  scoreText.textContent = context.score || "?";
  thresholdText.textContent = context.threshold || "?";
  openOnceButton.disabled = false;
  relevantButton.disabled = false;
  allowDomainButton.disabled = false;
}

openOnceButton.addEventListener("click", async () => {
  const response = await sendMessage({ type: "ALLOW_ONCE_OPEN" });
  if (!response?.ok) window.alert(response?.error || "Could not open page.");
});

relevantButton.addEventListener("click", async () => {
  relevantButton.disabled = true;
  const response = await sendMessage({ type: "MARK_RELEVANT_AND_OPEN" });
  if (!response?.ok) {
    relevantButton.disabled = false;
    window.alert(response?.error || "Could not save this correction.");
  }
});

allowDomainButton.addEventListener("click", async () => {
  const response = await sendMessage({ type: "ALLOW_DOMAIN_AND_OPEN" });
  if (!response?.ok)
    window.alert(response?.error || "Could not allow this domain.");
});

goBackButton.addEventListener("click", () => window.history.go(-2));

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}
