from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
from typing import Iterable


@dataclass(frozen=True)
class Example:
    goal: str
    page_text: str
    label: int
    group_id: str
    metadata: dict[str, object]


def load_jsonl(path: str | Path) -> list[Example]:
    source = Path(path)
    examples: list[Example] = []
    for line_number, line in enumerate(source.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{source}:{line_number}: invalid JSON") from error
        goal = _clean(row.get("goal"))
        page_text = _clean(row.get("page_text"))
        label = row.get("label")
        if not goal or not page_text or label not in (0, 1):
            raise ValueError(
                f"{source}:{line_number}: goal and page_text are required; label must be 0 or 1"
            )
        group_id = _group_id(row, page_text)
        metadata = {
            key: value
            for key, value in row.items()
            if key not in {"goal", "page_text", "label"}
        }
        examples.append(Example(goal, page_text, int(label), group_id, metadata))
    if not examples:
        raise ValueError(f"{source}: dataset is empty")
    return examples


def write_jsonl(path: str | Path, examples: Iterable[Example]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as handle:
        for example in examples:
            row = {
                "goal": example.goal,
                "page_text": example.page_text,
                "label": example.label,
                "group_id": example.group_id,
                **example.metadata,
            }
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def stable_bucket(value: str, seed: int) -> float:
    digest = hashlib.sha256(f"{seed}\0{value}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def split_examples(
    examples: list[Example],
    *,
    seed: int,
    validation_fraction: float,
    test_fraction: float,
    holdout_field: str | None = None,
) -> dict[str, list[Example]]:
    if validation_fraction <= 0 or test_fraction <= 0:
        raise ValueError("validation and test fractions must be positive")
    if validation_fraction + test_fraction >= 0.5:
        raise ValueError("at least half the data must remain in training")
    buckets: dict[str, list[Example]] = {"train": [], "validation": [], "test": []}
    components = _related_components(examples)
    component_holdouts: dict[str, str] = {}
    if holdout_field:
        for example, component in zip(examples, components):
            value = _clean(example.metadata.get(holdout_field))
            previous = component_holdouts.setdefault(component, value)
            if previous != value:
                raise ValueError(
                    f"related component {component!r} has conflicting {holdout_field} values"
                )
    for example, component in zip(examples, components):
        holdout = component_holdouts.get(component, "")
        key = f"{holdout_field}:{holdout}" if holdout else component
        value = stable_bucket(key, seed)
        split = (
            "test"
            if value < test_fraction
            else "validation"
            if value < test_fraction + validation_fraction
            else "train"
        )
        buckets[split].append(example)
    for name, rows in buckets.items():
        if not rows or {row.label for row in rows} != {0, 1}:
            raise ValueError(f"{name} split must contain both labels")
    assert_separate_splits(buckets)
    return buckets


def assert_separate_splits(splits: dict[str, list[Example]]) -> None:
    owners: dict[str, str] = {}
    for split, rows in splits.items():
        for row in rows:
            for key in _relation_keys(row):
                previous = owners.setdefault(key, split)
                if previous != split:
                    raise ValueError(f"group {key!r} appears in {previous} and {split}")


def _related_components(examples: list[Example]) -> list[str]:
    parent = list(range(len(examples)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        left, right = find(left), find(right)
        if left != right:
            parent[right] = left

    first_seen: dict[str, int] = {}
    for index, example in enumerate(examples):
        for key in _relation_keys(example):
            previous = first_seen.setdefault(key, index)
            union(index, previous)
    members: dict[int, list[str]] = {}
    for index, example in enumerate(examples):
        members.setdefault(find(index), []).append(example.group_id)
    names = {
        root: "component:"
        + hashlib.sha256("\0".join(sorted(values)).encode()).hexdigest()[:24]
        for root, values in members.items()
    }
    return [names[find(index)] for index in range(len(examples))]


def _relation_keys(example: Example) -> set[str]:
    keys = {example.group_id}
    for field in (
        "matched_group_id",
        "counterfactual_group_id",
        "goal_swap_group_id",
        "page_swap_group_id",
        "page_id",
        "canonical_url",
    ):
        value = _clean(example.metadata.get(field))
        if value:
            keys.add(f"{field}:{value}")
    normalized = re.sub(r"\W+", " ", example.page_text.lower()).strip()
    keys.add("text:" + hashlib.sha256(normalized.encode()).hexdigest()[:24])
    return keys


def _group_id(row: dict[str, object], page_text: str) -> str:
    for key in (
        "matched_group_id",
        "counterfactual_group_id",
        "goal_swap_group_id",
        "page_swap_group_id",
        "group_id",
        "page_id",
        "canonical_url",
    ):
        value = _clean(row.get(key))
        if value:
            return f"{key}:{value}"
    normalized = re.sub(r"\W+", " ", page_text.lower()).strip()
    return "text:" + hashlib.sha256(normalized.encode()).hexdigest()[:24]


def _clean(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()
