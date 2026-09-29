import assert from "node:assert/strict";
import test from "node:test";

import {
  decideRelevance,
  normalizedGoalKey,
  personalizedThreshold,
} from "../focuify/decisionPolicy.js";

const policy = { blockThreshold: 0.03, allowThreshold: 0.1 };

test("the uncertainty band prevents borderline pages from being blocked", () => {
  assert.equal(decideRelevance(0.02, 0.35, policy).state, "off_task");
  assert.equal(decideRelevance(0.07, 0.35, policy).state, "uncertain");
  assert.equal(decideRelevance(0.12, 0.35, policy).state, "relevant");
});

test("explicit positive feedback can only make blocking more lenient", () => {
  const learned = personalizedThreshold(0.2, [0.09, 0.1, 0.11, 0.12]);
  assert.ok(learned < 0.2);
  assert.equal(personalizedThreshold(0.08, [0.2, 0.3, 0.25]), 0.08);
});

test("a few accidental overrides do not immediately change the policy", () => {
  assert.equal(personalizedThreshold(0.15, [0.03, 0.04]), 0.15);
});

test("goal keys ignore harmless punctuation and casing differences", () => {
  assert.equal(
    normalizedGoalKey("Study: Cellular Respiration!"),
    normalizedGoalKey("study cellular respiration"),
  );
});
