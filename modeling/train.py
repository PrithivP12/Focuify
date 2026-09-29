#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import random
import time

import numpy as np

from focuify_model.data import Example, load_jsonl
from focuify_model.metrics import choose_thresholds, evaluate_scores


def select_device(requested: str) -> str:
    import torch

    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def score_model(model, loader, device: str) -> tuple[list[int], list[float]]:
    import torch

    model.eval()
    labels: list[int] = []
    scores: list[float] = []
    with torch.inference_mode():
        for batch in loader:
            batch_labels = batch.pop("labels")
            logits = model(**{key: value.to(device) for key, value in batch.items()}).logits
            labels.extend(batch_labels.tolist())
            scores.extend(torch.sigmoid(logits.reshape(-1)).cpu().tolist())
    return labels, scores


def main() -> None:
    parser = argparse.ArgumentParser(description="Fine-tune the Focuify relevance cross-encoder.")
    parser.add_argument("--model", default="mixedbread-ai/mxbai-rerank-xsmall-v1")
    parser.add_argument("--revision", default="b5c6e9da73abc3711f593f705371cdbe9e0fe422")
    parser.add_argument("--train-data", default="data/processed/train.jsonl")
    parser.add_argument("--validation-data", default="data/processed/validation.jsonl")
    parser.add_argument("--output-dir", default="artifacts/focuify-v2")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=1e-5)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--warmup-ratio", type=float, default=0.1)
    parser.add_argument("--max-length", type=int, default=256)
    parser.add_argument("--seed", type=int, default=20260929)
    parser.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="auto")
    parser.add_argument("--local-files-only", action="store_true")
    args = parser.parse_args()
    if args.epochs < 1 or args.batch_size < 1 or args.max_length < 32:
        raise ValueError("epochs, batch-size, and max-length must be positive")

    import torch
    from torch.utils.data import DataLoader, Dataset
    from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = select_device(args.device)
    train_rows = load_jsonl(args.train_data)
    validation_rows = load_jsonl(args.validation_data)
    tokenizer = AutoTokenizer.from_pretrained(
        args.model,
        revision=args.revision,
        local_files_only=args.local_files_only,
    )
    model = AutoModelForSequenceClassification.from_pretrained(
        args.model,
        revision=args.revision,
        local_files_only=args.local_files_only,
        num_labels=1,
        dtype=torch.float32,
    ).to(device)

    class PairDataset(Dataset):
        def __init__(self, rows: list[Example]) -> None:
            self.rows = rows

        def __len__(self) -> int:
            return len(self.rows)

        def __getitem__(self, index: int) -> Example:
            return self.rows[index]

    def collate(rows: list[Example]) -> dict[str, torch.Tensor]:
        encoded = tokenizer(
            [row.goal for row in rows],
            [row.page_text for row in rows],
            padding=True,
            truncation=True,
            max_length=args.max_length,
            return_tensors="pt",
        )
        encoded["labels"] = torch.tensor([row.label for row in rows], dtype=torch.float32)
        return encoded

    generator = torch.Generator().manual_seed(args.seed)
    train_loader = DataLoader(
        PairDataset(train_rows),
        batch_size=args.batch_size,
        shuffle=True,
        collate_fn=collate,
        generator=generator,
    )
    validation_loader = DataLoader(
        PairDataset(validation_rows),
        batch_size=args.batch_size * 2,
        shuffle=False,
        collate_fn=collate,
    )
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )
    total_steps = len(train_loader) * args.epochs
    scheduler = get_linear_schedule_with_warmup(
        optimizer,
        num_warmup_steps=math.ceil(total_steps * args.warmup_ratio),
        num_training_steps=total_steps,
    )
    loss_function = torch.nn.BCEWithLogitsLoss()
    output = Path(args.output_dir)
    best_dir = output / "model"
    history: list[dict[str, object]] = []
    best_selection_score = -math.inf
    started = time.perf_counter()

    for epoch in range(1, args.epochs + 1):
        model.train()
        losses = []
        for batch in train_loader:
            labels = batch.pop("labels").to(device)
            optimizer.zero_grad(set_to_none=True)
            logits = model(**{key: value.to(device) for key, value in batch.items()}).logits.reshape(-1)
            loss = loss_function(logits, labels)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            losses.append(float(loss.detach().cpu()))
        labels, scores = score_model(model, validation_loader, device)
        thresholds = choose_thresholds(labels, scores)
        metrics = evaluate_scores(labels, scores, thresholds)
        selection_score = (
            float(metrics["roc_auc"])
            + 0.15 * float(metrics["off_task_detection_recall"])
            - 0.1 * float(metrics["uncertain_rate"])
        )
        epoch_result = {
            "epoch": epoch,
            "training_loss": float(np.mean(losses)),
            "selection_score": selection_score,
            **metrics,
        }
        history.append(epoch_result)
        print(json.dumps(epoch_result, sort_keys=True), flush=True)
        if selection_score > best_selection_score:
            best_selection_score = selection_score
            best_dir.mkdir(parents=True, exist_ok=True)
            model.save_pretrained(best_dir)
            tokenizer.save_pretrained(best_dir)

    summary = {
        "schema_version": 1,
        "base_model": args.model,
        "base_revision": args.revision,
        "device": device,
        "train_rows": len(train_rows),
        "validation_rows": len(validation_rows),
        "seconds": time.perf_counter() - started,
        "best_selection_score": best_selection_score,
        "history": history,
        "config": vars(args),
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "training_summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
