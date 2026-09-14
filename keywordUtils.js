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

export function extractKeywords(value, limit = 36) {
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
    .slice(0, Math.max(1, Math.min(80, Number(limit) || 36)))
    .map(([word]) => word);
}

export function compactPageEvidence(
  payload,
  maxChars = 1500,
  maxKeywords = 36,
) {
  const title = sanitizeText(payload?.title, 180);
  const channel = sanitizeText(payload?.channel, 120);
  const metaDescription = sanitizeText(payload?.metaDescription, 260);
  const headings = uniqueStrings(payload?.headings).slice(0, 8);
  const keywords = uniqueStrings(payload?.keywords)
    .map(sanitizeKeyword)
    .filter(Boolean)
    .slice(0, maxKeywords);
  const text = sanitizeText(payload?.text, maxChars);
  const compact = [
    title && `Title: ${title}`,
    channel && `Channel: ${channel}`,
    headings.length && `Headings: ${headings.join(" | ")}`,
    keywords.length && `Keywords: ${keywords.join(", ")}`,
    metaDescription && `Description: ${metaDescription}`,
    text && `Page text: ${text}`,
  ]
    .filter(Boolean)
    .join("\n");
  return compact
    ? {
        compact: compact.slice(0, 2400),
        keywords,
        title,
        channel,
        headings,
        description: metaDescription,
        sourceType: ["video", "search"].includes(payload?.sourceType)
          ? payload.sourceType
          : "page",
      }
    : null;
}

export function rankingDocuments(evidence) {
  if (!evidence?.compact) return [];
  if (!["video", "search"].includes(evidence.sourceType))
    return [evidence.compact];
  return [
    ...new Set(
      [
        sanitizeText(evidence.title, 220),
        sanitizeText(evidence.headings?.join(". "), 500),
        sanitizeText(evidence.description, 500),
        evidence.compact,
      ].filter((value) => value.length >= 3),
    ),
  ];
}

export function extractSearchQuery(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!/^google\.[a-z.]{2,}$/.test(host) || url.pathname !== "/search")
      return "";
    return sanitizeText(url.searchParams.get("q"), 220);
  } catch {
    return "";
  }
}

export function sanitizeText(value, maxChars = 1000) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function uniqueStrings(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => sanitizeText(value, 120))
        .filter(Boolean),
    ),
  ];
}
function sanitizeKeyword(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 48);
}
