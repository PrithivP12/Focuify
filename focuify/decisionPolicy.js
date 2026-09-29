const MIN_FEEDBACK_FOR_ADAPTATION = 3;

export function decideRelevance(
  score,
  blockingLevel,
  modelPolicy,
  positiveScores = [],
) {
  if (!Number.isFinite(score)) throw new TypeError("score must be finite");
  const policy = validatePolicy(modelPolicy);
  const level = Math.min(1, Math.max(0, Number(blockingLevel) || 0));
  const configuredThreshold =
    policy.blockThreshold +
    level * (policy.allowThreshold - policy.blockThreshold) * 0.75;
  const blockThreshold = personalizedThreshold(
    configuredThreshold,
    positiveScores,
  );
  const state =
    score < blockThreshold
      ? "off_task"
      : score < policy.allowThreshold
        ? "uncertain"
        : "relevant";
  return {
    state,
    score,
    blockThreshold,
    allowThreshold: policy.allowThreshold,
  };
}

export function personalizedThreshold(configuredThreshold, positiveScores = []) {
  const configured = Math.min(1, Math.max(0, Number(configuredThreshold) || 0));
  const usable = positiveScores
    .map(Number)
    .filter((score) => Number.isFinite(score) && score >= 0 && score <= 1)
    .sort((left, right) => left - right);
  if (usable.length < MIN_FEEDBACK_FOR_ADAPTATION) return configured;
  const lowerDecile = usable[Math.floor((usable.length - 1) * 0.1)];
  return Math.min(configured, Math.max(0.001, lowerDecile - 0.015));
}

export function normalizedGoalKey(goal) {
  return String(goal || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 220);
}

function validatePolicy(policy) {
  const blockThreshold = Number(policy?.blockThreshold);
  const allowThreshold = Number(policy?.allowThreshold);
  if (
    !Number.isFinite(blockThreshold) ||
    !Number.isFinite(allowThreshold) ||
    blockThreshold < 0 ||
    allowThreshold > 1 ||
    blockThreshold >= allowThreshold
  ) {
    throw new TypeError("invalid model policy");
  }
  return { blockThreshold, allowThreshold };
}
