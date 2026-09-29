#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from focuify_model.data import Example, load_jsonl
from focuify_model.metrics import choose_thresholds, evaluate_scores, release_checks


def score(model_path: str, rows: list[Example], max_length: int, batch_size: int) -> list[float]:
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    device = "cuda" if torch.cuda.is_available() else "mps" if hasattr(torch.backends, "mps") and torch.backends.mps.is_available() else "cpu"
    tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
    model = AutoModelForSequenceClassification.from_pretrained(
        model_path, local_files_only=True
    ).to(device).eval()
    output: list[float] = []
    with torch.inference_mode():
        for start in range(0, len(rows), batch_size):
            batch = rows[start : start + batch_size]
            encoded = tokenizer(
                [row.goal for row in batch],
                [row.page_text for row in batch],
                padding=True,
                truncation=True,
                max_length=max_length,
                return_tensors="pt",
            )
            logits = model(**{key: value.to(device) for key, value in encoded.items()}).logits
            output.extend(torch.sigmoid(logits.reshape(-1)).cpu().tolist())
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Calibrate on validation data and evaluate once on test data.")
    parser.add_argument("--model", default="artifacts/focuify-v2/model")
    parser.add_argument("--validation-data", default="data/processed/validation.jsonl")
    parser.add_argument("--test-data", nargs="+", default=["data/processed/test.jsonl"])
    parser.add_argument("--output", default="artifacts/focuify-v2/evaluation.json")
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--batch-size", type=int, default=32)
    args = parser.parse_args()

    validation = load_jsonl(args.validation_data)
    validation_scores = score(args.model, validation, args.max_length, args.batch_size)
    thresholds = choose_thresholds([row.label for row in validation], validation_scores)
    suites = {}
    for test_path in args.test_data:
        test = load_jsonl(test_path)
        test_scores = score(args.model, test, args.max_length, args.batch_size)
        metrics = evaluate_scores([row.label for row in test], test_scores, thresholds)
        checks = release_checks(metrics)
        suites[str(test_path)] = {
            "rows": len(test),
            "metrics": metrics,
            "release_checks": checks,
            "passed": all(checks.values()),
        }
    result = {
        "schema_version": 1,
        "threshold_source": "validation_only",
        "validation_rows": len(validation),
        "thresholds": {"block": thresholds.block, "allow": thresholds.allow},
        "test_suites": suites,
        "release_candidate": all(suite["passed"] for suite in suites.values()),
    }
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    if not result["release_candidate"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
