import json

from focuify_model.data import load_jsonl, split_examples


def test_related_rows_stay_together(tmp_path):
    path = tmp_path / "rows.jsonl"
    rows = []
    for group in range(30):
        for label in (0, 1):
            rows.append(
                {
                    "goal": f"goal {group} {label}",
                    "page_text": f"page {group} {label}",
                    "label": label,
                    "matched_group_id": f"group-{group}",
                }
            )
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
    splits = split_examples(
        load_jsonl(path), seed=42, validation_fraction=0.2, test_fraction=0.2
    )
    owners = {}
    for name, values in splits.items():
        for value in values:
            assert owners.setdefault(value.group_id, name) == name


def test_transitive_relationships_stay_together(tmp_path):
    path = tmp_path / "transitive.jsonl"
    rows = []
    for index in range(40):
        rows.extend(
            [
                {
                    "goal": f"goal {index} a",
                    "page_text": f"page {index} a",
                    "label": 0,
                    "matched_group_id": f"pair-{index}",
                    "page_id": f"bridge-{index}",
                },
                {
                    "goal": f"goal {index} b",
                    "page_text": f"page {index} b",
                    "label": 1,
                    "goal_swap_group_id": f"swap-{index}",
                    "page_id": f"bridge-{index}",
                },
            ]
        )
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
    splits = split_examples(
        load_jsonl(path), seed=7, validation_fraction=0.2, test_fraction=0.2
    )
    owners = {}
    for name, values in splits.items():
        for value in values:
            page_id = value.metadata["page_id"]
            assert owners.setdefault(page_id, name) == name
