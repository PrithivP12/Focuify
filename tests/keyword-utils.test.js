import assert from "node:assert/strict";
import test from "node:test";

import {
  compactPageEvidence,
  rankingDocuments,
} from "../focuify/keywordUtils.js";

test("page evidence is bounded and useful fields are retained", () => {
  const evidence = compactPageEvidence({
    title: "Cellular respiration lesson",
    headings: ["Glycolysis", "Citric acid cycle"],
    metaDescription: "A worked biology lesson",
    text: "ATP and glucose are explained. ".repeat(200),
    keywords: ["ATP", "glucose", "glucose"],
  });
  assert.match(evidence.compact, /Cellular respiration/);
  assert.ok(evidence.compact.length <= 2400);
  assert.deepEqual(evidence.keywords, ["atp", "glucose"]);
});

test("long pages are ranked as several bounded views", () => {
  const evidence = compactPageEvidence({
    title: "Long lesson",
    text: "A detailed explanation of the assigned topic. ".repeat(90),
  });
  const documents = rankingDocuments(evidence);
  assert.ok(documents.length >= 2);
  assert.ok(documents.length <= 8);
  assert.ok(documents.every((document) => document.length <= 2400));
});
