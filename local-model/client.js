let creating;
export async function ensureModelDocument() {
  if (creating) return creating;
  creating = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL("local-model/offscreen.html")],
    });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: "local-model/offscreen.html",
        reasons: ["WORKERS"],
        justification:
          "Run the bundled relevance model in a dedicated inference worker.",
      });
    }
  })();
  try {
    await creating;
  } finally {
    creating = null;
  }
}
export async function requestTextRanking(query, documents) {
  await ensureModelDocument();
  const response = await chrome.runtime.sendMessage({
    target: "focuify-text-ranking",
    query,
    documents,
  });
  if (!response?.ok)
    throw new Error(
      response?.error || "Local relevance worker did not respond.",
    );
  return {
    scores: Array.isArray(response.scores) ? response.scores.map(Number) : [],
    modelVersion: String(response.modelVersion || ""),
    backend: String(response.backend || ""),
    durationMs: Math.max(0, Number(response.durationMs) || 0),
    loadDurationMs: Math.max(0, Number(response.loadDurationMs) || 0),
  };
}
