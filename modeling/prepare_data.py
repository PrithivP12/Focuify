#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from focuify_model.data import load_jsonl, split_examples, write_jsonl


def main() -> None:
    parser = argparse.ArgumentParser(description="Create deterministic, group-safe model splits.")
    parser.add_argument("inputs", nargs="+")
    parser.add_argument("--output-dir", default="data/processed")
    parser.add_argument("--seed", type=int, default=20260929)
    parser.add_argument("--validation-fraction", type=float, default=0.15)
    parser.add_argument("--test-fraction", type=float, default=0.15)
    parser.add_argument("--holdout-field", default=None)
    args = parser.parse_args()

    rows = [row for path in args.inputs for row in load_jsonl(path)]
    splits = split_examples(
        rows,
        seed=args.seed,
        validation_fraction=args.validation_fraction,
        test_fraction=args.test_fraction,
        holdout_field=args.holdout_field,
    )
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    for name, values in splits.items():
        write_jsonl(output / f"{name}.jsonl", values)
    summary = {
        "seed": args.seed,
        "holdout_field": args.holdout_field,
        "splits": {
            name: {"rows": len(values), "positive": sum(row.label for row in values)}
            for name, values in splits.items()
        },
    }
    (output / "split_summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
