#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from focuify_model.data import Example, assert_separate_splits, load_jsonl, write_jsonl


def deduplicate(rows: list[Example]) -> list[Example]:
    seen: set[tuple[str, str, int]] = set()
    output = []
    for row in rows:
        key = (row.goal.lower(), row.page_text.lower(), row.label)
        if key not in seen:
            output.append(row)
            seen.add(key)
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Combine existing splits without moving examples between them.")
    parser.add_argument("--train", nargs="+", required=True)
    parser.add_argument("--validation", nargs="+", required=True)
    parser.add_argument("--test", nargs="+", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    sources = {name: getattr(args, name) for name in ("train", "validation", "test")}
    splits = {
        name: deduplicate([row for path in paths for row in load_jsonl(path)])
        for name, paths in sources.items()
    }
    assert_separate_splits(splits)
    output = Path(args.output_dir)
    for name, rows in splits.items():
        write_jsonl(output / f"{name}.jsonl", rows)
    summary = {
        name: {"rows": len(rows), "positive": sum(row.label for row in rows)}
        for name, rows in splits.items()
    }
    (output / "assembly_summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
