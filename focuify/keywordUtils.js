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
        sourceType: payload?.sourceType === "video" ? "video" : "page",
      }
    : null;
}

export function rankingDocuments(evidence) {
  if (!evidence?.compact) return [];
  const summary = sanitizeText(
    [evidence.title, evidence.headings?.join(". "), evidence.description]
      .filter(Boolean)
      .join(". "),
    760,
  );
  return [
    ...new Set(
      [summary, ...splitText(evidence.compact, 900, 120), evidence.compact]
        .map((value) => sanitizeText(value, 2400))
        .filter((value) => value.length >= 3),
    ),
  ].slice(0, 8);
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

function splitText(value, size, overlap) {
  const text = sanitizeText(value, 2400);
  if (text.length <= size) return [text];
  const chunks = [];
  for (let start = 0; start < text.length; start += size - overlap) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return chunks;
}
