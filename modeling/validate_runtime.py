#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from evaluate import score as score_native
from focuify_model.data import Example, load_jsonl


def score_onnx(model_path: str, rows: list[Example], max_length: int, batch_size: int) -> list[float]:
    import onnxruntime as ort
    from transformers import AutoTokenizer

    model_file = Path(model_path)
    tokenizer = AutoTokenizer.from_pretrained(model_file.parent, local_files_only=True)
    session = ort.InferenceSession(str(model_file), providers=["CPUExecutionProvider"])
    input_names = {value.name for value in session.get_inputs()}
    output = []
    for start in range(0, len(rows), batch_size):
        batch = rows[start : start + batch_size]
        encoded = tokenizer(
            [row.goal for row in batch],
            [row.page_text for row in batch],
            padding=True,
            truncation=True,
            max_length=max_length,
            return_tensors="np",
        )
        feed = {name: value for name, value in encoded.items() if name in input_names}
        logits = np.asarray(session.run(None, feed)[0], dtype=np.float64).reshape(-1)
        output.extend((1 / (1 + np.exp(-logits))).tolist())
    return output


def decisions(scores: np.ndarray, block: float, allow: float) -> np.ndarray:
    return np.where(scores < block, 0, np.where(scores >= allow, 2, 1))


def main() -> None:
    parser = argparse.ArgumentParser(description="Check native and quantized browser model agreement.")
    parser.add_argument("--native-model", default="artifacts/focuify-v2/model")
    parser.add_argument("--onnx-model", default="artifacts/focuify-v2/browser/model_quantized.onnx")
    parser.add_argument("--data", default="artifacts/data/validation.jsonl")
    parser.add_argument("--evaluation", default="artifacts/focuify-v2/evaluation.json")
    parser.add_argument("--output", default="artifacts/focuify-v2/runtime_validation.json")
    parser.add_argument("--samples", type=int, default=512)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--max-length", type=int, default=256)
    args = parser.parse_args()

    rows = load_jsonl(args.data)[: args.samples]
    policy = json.loads(Path(args.evaluation).read_text(encoding="utf-8"))["thresholds"]
    native = np.asarray(score_native(args.native_model, rows, args.max_length, args.batch_size))
    browser = np.asarray(score_onnx(args.onnx_model, rows, args.max_length, args.batch_size))
    difference = np.abs(native - browser)
    agreement = float(
        np.mean(
            decisions(native, policy["block"], policy["allow"])
            == decisions(browser, policy["block"], policy["allow"])
        )
    )
    result = {
        "schema_version": 1,
        "samples": len(rows),
        "max_absolute_error": float(np.max(difference)),
        "mean_absolute_error": float(np.mean(difference)),
        "decision_agreement": agreement,
        "checks": {
            "max_absolute_error_at_most_0_12": float(np.max(difference)) <= 0.12,
            "decision_agreement_at_least_0_99": agreement >= 0.99,
        },
    }
    result["passed"] = all(result["checks"].values())
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    if not result["passed"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
