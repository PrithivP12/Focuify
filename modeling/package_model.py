#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Install a passing custom checkpoint into the extension.")
    parser.add_argument("--browser-model", default="artifacts/focuify-v2/browser")
    parser.add_argument("--evaluation", default="artifacts/focuify-v2/evaluation.json")
    parser.add_argument(
        "--runtime-validation",
        default="artifacts/focuify-v2/runtime_validation.json",
    )
    parser.add_argument("--destination", default="../focuify/local-model/model")
    parser.add_argument("--manifest", default="../focuify/local-model/model-manifest.json")
    parser.add_argument("--policy-module", default="../focuify/modelPolicy.js")
    parser.add_argument("--model-version", required=True)
    parser.add_argument("--max-length", type=int, default=256)
    args = parser.parse_args()

    evaluation = json.loads(Path(args.evaluation).read_text(encoding="utf-8"))
    if evaluation.get("release_candidate") is not True:
        raise RuntimeError("refusing to package a model that failed release checks")
    runtime_validation = json.loads(
        Path(args.runtime_validation).read_text(encoding="utf-8")
    )
    if runtime_validation.get("passed") is not True:
        raise RuntimeError("refusing to package a model that failed runtime validation")
    source = Path(args.browser_model)
    model_file = source / "model_quantized.onnx"
    if not model_file.is_file():
        raise FileNotFoundError(model_file)
    destination = Path(args.destination)
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"):
        candidate = source / name
        if candidate.is_file():
            shutil.copy2(candidate, destination / name)
    (destination / "onnx").mkdir(exist_ok=True)
    installed_model = destination / "onnx" / "model_quantized.onnx"
    shutil.copy2(model_file, installed_model)
    thresholds = evaluation["thresholds"]
    manifest = {
        "schema_version": 1,
        "model_id": "focuify/focuify-relevance-v2",
        "model_version": args.model_version,
        "source_model": "mixedbread-ai/mxbai-rerank-xsmall-v1",
        "source_revision": "b5c6e9da73abc3711f593f705371cdbe9e0fe422",
        "model_path": "model",
        "model_file": "onnx/model_quantized.onnx",
        "model_sha256": sha256(installed_model),
        "threshold": thresholds["allow"],
        "block_threshold": thresholds["block"],
        "dtype": "q8",
        "score_transform": "sigmoid",
        "max_length": args.max_length,
        "status": "ready",
    }
    Path(args.manifest).write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    Path(args.policy_module).write_text(
        "export const MODEL_POLICY = Object.freeze({\n"
        f"  blockThreshold: {thresholds['block']!r},\n"
        f"  allowThreshold: {thresholds['allow']!r},\n"
        "});\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
