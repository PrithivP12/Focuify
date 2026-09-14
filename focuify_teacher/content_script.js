(() => {
  if (globalThis.__focuifyContentLoaded) {
    globalThis.__focuifyRequestScan?.();
    return;
  }
  globalThis.__focuifyContentLoaded = true;

  const PAGE_SCAN_DELAY_MS = 420;
  const PAGE_SCAN_RETRY_MS = 1600;
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const PAGE_MAX_CHARS = 1800;
  const MAX_KEYWORDS = 36;
  const ACCESSIBILITY_STYLE_ID = "focuify-accessibility-style";
  const STOPWORDS = new Set([
    "about",
    "after",
    "again",
    "also",
    "and",
    "are",
    "because",
    "been",
    "before",
    "being",
    "between",
    "could",
    "from",
    "have",
    "into",
    "more",
    "most",
    "other",
    "over",
    "same",
    "some",
    "than",
    "that",
    "their",
    "there",
    "these",
    "they",
    "this",
    "those",
    "through",
    "under",
    "using",
    "were",
    "which",
    "while",
    "with",
    "would",
    "your",
    "the",
    "for",
    "not",
    "you",
    "study",
  ]);
  let scanTimer = 0;
  let lastScanKey = "";

  function bootstrap() {
    installAccessibility();
    scheduleScan(true);
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        scheduleScan(true);
      }
    }, 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") scheduleScan(true);
    });
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "FOCUIFY_SCAN_NOW") scheduleScan(true);
      if (message?.type === "FOCUIFY_ACCESSIBILITY_CHANGED")
        applyAccessibility(message.settings);
    });
    setInterval(() => {
      if (document.visibilityState !== "hidden")
        chrome.runtime.sendMessage(
          { type: "FOCUIFY_HEARTBEAT" },
          () => void chrome.runtime.lastError,
        );
    }, HEARTBEAT_INTERVAL_MS);
  }

  function scheduleScan(force = false) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      sendPageEvidence(force, true);
    }, PAGE_SCAN_DELAY_MS);
  }

  function sendPageEvidence(force = false, retry = false) {
    if (
      document.visibilityState === "hidden" ||
      !/^https?:\/\//i.test(location.href)
    )
      return;
    const snapshot = extractPageSnapshot();
    const scanKey = `${location.href}|${snapshot.keywords.join(",")}|${snapshot.text.slice(0, 180)}`;
    if (!force && scanKey === lastScanKey) return;
    chrome.runtime.sendMessage(
      { type: "ANALYZE_PAGE", payload: snapshot },
      (response) => {
        if (!chrome.runtime.lastError && response?.ok) {
          lastScanKey = scanKey;
          return;
        }
        if (retry)
          setTimeout(() => sendPageEvidence(true, false), PAGE_SCAN_RETRY_MS);
      },
    );
  }

  function extractPageSnapshot() {
    const root = document.querySelector("article, main") || document.body;
    const youtubeVideo =
      /(^|\.)youtube\.com$/i.test(location.hostname) &&
      (/^\/watch(?:\/|$)/.test(location.pathname) ||
        /^\/shorts\//.test(location.pathname));
    const visibleVideoTitle = youtubeVideo
      ? normalize(
          document.querySelector(
            "h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, h2.ytd-reel-player-header-renderer",
          )?.textContent,
        )
      : "";
    const title = (
      visibleVideoTitle ||
      normalize(document.title).replace(/\s+-\s+YouTube$/i, "")
    ).slice(0, 180);
    const metaDescription = normalize(
      document.querySelector('meta[name="description"]')?.content || "",
    ).slice(0, 260);
    const channel = youtubeVideo
      ? normalize(
          document.querySelector(
            "ytd-channel-name a, #owner #channel-name a, .ytp-title-channel",
          )?.textContent,
        ).slice(0, 120)
      : "";
    const pageHeadings = [...(root?.querySelectorAll("h1,h2,h3") || [])]
      .map((node) => normalize(node.innerText || node.textContent))
      .filter((value) => value.length >= 2)
      .slice(0, 8);
    const headings = dedupe([
      ...(visibleVideoTitle ? [visibleVideoTitle] : []),
      ...pageHeadings,
    ]).slice(0, 8);
    const blocks = [...(root?.querySelectorAll("p,li,blockquote,pre") || [])]
      .filter(
        (node) =>
          !node.closest(
            "nav,header,footer,aside,form,script,style,noscript,[role='navigation']",
          ),
      )
      .map((node) => normalize(node.innerText || node.textContent))
      .filter((value) => value.length >= 28 && value.length <= 420);
    const extractedBlocks = dedupe(blocks).join(" ");
    const fallbackText = normalize(root?.innerText || root?.textContent || "");
    const videoDescription = youtubeVideo
      ? normalize(
          document.querySelector(
            "#description-inline-expander, ytd-text-inline-expander#description-inline-expander",
          )?.textContent,
        )
      : "";
    const focusedVideoText = dedupe(
      [title, channel, metaDescription, videoDescription].filter(Boolean),
    ).join(" ");
    const text = (
      youtubeVideo && focusedVideoText.length >= 40
        ? focusedVideoText
        : extractedBlocks.length >= 160
          ? extractedBlocks
          : fallbackText
    ).slice(0, PAGE_MAX_CHARS);
    const keywordSource = [
      title,
      metaDescription,
      headings.join(" "),
      text,
    ].join(" ");
    return {
      url: location.href,
      sourceType: youtubeVideo ? "video" : "page",
      title,
      channel,
      metaDescription,
      headings,
      keywords: extractKeywords(keywordSource),
      text,
    };
  }

  function extractKeywords(value) {
    const counts = new Map();
    const words =
      String(value || "")
        .toLowerCase()
        .match(/[a-z][a-z0-9-]{2,}/g) || [];
    for (const word of words) {
      if (STOPWORDS.has(word) || word.length > 42) continue;
      counts.set(word, (counts.get(word) || 0) + 1);
    }
    return [...counts.entries()]
      .sort(
        (a, b) =>
          b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]),
      )
      .slice(0, MAX_KEYWORDS)
      .map(([word]) => word);
  }

  function installAccessibility() {
    applyAccessibility();
    chrome.runtime.sendMessage(
      { type: "GET_ACCESSIBILITY_SETTINGS" },
      (response) => {
        if (!chrome.runtime.lastError && response?.ok)
          applyAccessibility(response.settings);
      },
    );
  }

  function applyAccessibility(stored = {}) {
    const theme = ["light", "dark", "zen"].includes(stored.themeMode)
      ? stored.themeMode
      : "light";
    const scale = Math.min(1.25, Math.max(0.85, Number(stored.fontScale) || 1));
    document.documentElement.dataset.focuifyTheme = theme;
    document.documentElement.style.setProperty(
      "--focuify-font-scale",
      String(scale),
    );
    let style = document.getElementById(ACCESSIBILITY_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = ACCESSIBILITY_STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = `
    :root { font-size: calc(100% * var(--focuify-font-scale, 1)); }
    ${stored.highContrast ? "* { text-shadow: none !important; } body { background: #fff !important; color: #000 !important; } a { color: #003cff !important; }" : ""}
    ${stored.reducedMotion ? "*, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: 0.001ms !important; }" : ""}
  `;
  }

  function normalize(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function dedupe(values) {
    return [...new Set(values)];
  }

  globalThis.__focuifyRequestScan = () => scheduleScan(true);
  bootstrap();
})();
