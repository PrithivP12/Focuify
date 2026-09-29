from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score


@dataclass(frozen=True)
class Thresholds:
    block: float
    allow: float


def choose_thresholds(
    labels: Sequence[int],
    scores: Sequence[float],
    *,
    max_false_block_rate: float = 0.01,
    max_false_allow_rate: float = 0.05,
) -> Thresholds:
    y, probability = _arrays(labels, scores)
    positives = np.sort(probability[y == 1])
    negatives = np.sort(probability[y == 0])
    block_index = min(len(positives) - 1, int(len(positives) * max_false_block_rate))
    allow_index = max(0, int(np.ceil(len(negatives) * (1 - max_false_allow_rate))) - 1)
    positive_safety_boundary = max(0.0, float(positives[block_index]) - 1e-7)
    negative_safety_boundary = min(1.0, float(negatives[allow_index]) + 1e-7)
    return Thresholds(
        min(positive_safety_boundary, negative_safety_boundary),
        max(positive_safety_boundary, negative_safety_boundary),
    )


def evaluate_scores(
    labels: Sequence[int], scores: Sequence[float], thresholds: Thresholds
) -> dict[str, object]:
    y, probability = _arrays(labels, scores)
    decisions = np.where(
        probability < thresholds.block,
        "off_task",
        np.where(probability >= thresholds.allow, "relevant", "uncertain"),
    )
    binary = (decisions != "off_task").astype(int)
    return {
        "samples": int(len(y)),
        "accuracy": float(accuracy_score(y, binary)),
        "precision_relevant": float(precision_score(y, binary, zero_division=0)),
        "recall_relevant": float(recall_score(y, binary, zero_division=0)),
        "f1": float(f1_score(y, binary, zero_division=0)),
        "roc_auc": float(roc_auc_score(y, probability)),
        "false_block_rate": float(np.mean(decisions[y == 1] == "off_task")),
        "off_task_detection_recall": float(np.mean(decisions[y == 0] == "off_task")),
        "uncertain_rate": float(np.mean(decisions == "uncertain")),
        "off_task": int(np.sum(decisions == "off_task")),
        "uncertain": int(np.sum(decisions == "uncertain")),
        "relevant": int(np.sum(decisions == "relevant")),
        "thresholds": {"block": thresholds.block, "allow": thresholds.allow},
    }


def release_checks(metrics: dict[str, object]) -> dict[str, bool]:
    return {
        "roc_auc_at_least_0_80": float(metrics["roc_auc"]) >= 0.80,
        "false_block_rate_at_most_0_02": float(metrics["false_block_rate"]) <= 0.02,
        "off_task_recall_at_least_0_65": float(metrics["off_task_detection_recall"]) >= 0.65,
        "uncertain_rate_at_most_0_35": float(metrics["uncertain_rate"]) <= 0.35,
    }


def _arrays(labels: Sequence[int], scores: Sequence[float]) -> tuple[np.ndarray, np.ndarray]:
    y = np.asarray(labels, dtype=np.int64)
    probability = np.asarray(scores, dtype=np.float64)
    if y.shape != probability.shape or y.ndim != 1 or not len(y):
        raise ValueError("labels and scores must be non-empty one-dimensional arrays of equal length")
    if set(y.tolist()) != {0, 1} or not np.all(np.isfinite(probability)):
        raise ValueError("labels must contain both 0 and 1 and scores must be finite")
    return y, probability
