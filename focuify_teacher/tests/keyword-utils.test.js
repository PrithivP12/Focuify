import test from "node:test";
import assert from "node:assert/strict";
import {
  compactPageEvidence,
  extractKeywords,
  extractSearchQuery,
  rankingDocuments,
} from "../keywordUtils.js";

test("extractKeywords keeps useful repeated terms and removes stopwords", () => {
  const words = extractKeywords(
    "The biology biology lesson explains cellular respiration and mitochondria.",
  );
  assert.deepEqual(words.slice(0, 3), [
    "biology",
    "mitochondria",
    "respiration",
  ]);
  assert.ok(!words.includes("the"));
});

test("compactPageEvidence caps the payload and retains keyword signals", () => {
  const evidence = compactPageEvidence(
    {
      title: "Cellular respiration",
      headings: ["Mitochondria"],
      keywords: ["mitochondria", "respiration", "respiration"],
      metaDescription: "How cells make ATP",
      text: "x".repeat(10000),
    },
    120,
  );
  assert.ok(evidence.compact.length < 800);
  assert.deepEqual(evidence.keywords, ["mitochondria", "respiration"]);
  assert.match(evidence.compact, /Keywords:/);
});

test("video evidence is scored from focused metadata as well as the compact page", () => {
  const evidence = compactPageEvidence({
    sourceType: "video",
    title: "Cellular respiration and ATP",
    channel: "Open Biology Classroom",
    metaDescription: "A biology lesson about mitochondria",
    headings: ["How cells release energy"],
    keywords: ["cellular", "respiration", "biology"],
    text: "Recommended videos comments navigation",
  });
  assert.deepEqual(rankingDocuments(evidence).slice(0, 3), [
    "Cellular respiration and ATP",
    "How cells release energy",
    "A biology lesson about mitochondria",
  ]);
  assert.match(evidence.compact, /Channel: Open Biology Classroom/);
});

test("search evidence retains its source type", () => {
  const evidence = compactPageEvidence({
    sourceType: "search",
    title: "cellular respiration",
    text: "cellular respiration",
  });
  assert.equal(evidence.sourceType, "search");
  assert.deepEqual(rankingDocuments(evidence).slice(0, 1), [
    "cellular respiration",
  ]);
});

test("Google search queries are extracted without retaining the rest of the URL", () => {
  assert.equal(
    extractSearchQuery(
      "https://www.google.com/search?q=cellular+respiration&sourceid=chrome",
    ),
    "cellular respiration",
  );
  assert.equal(
    extractSearchQuery("https://example.com/search?q=cellular+respiration"),
    "",
  );
});
