# Focuify model pipeline

This directory builds a compact cross-encoder for the decision Focuify actually
needs: whether a page can help with the user's current focus goal. It is not a chat
model and does not pretend to be a general-purpose LLM. A specialized reranker is
faster, smaller, easier to evaluate, and safer for a browser-blocking decision.

## Release contract

A candidate is calibrated on validation data and evaluated once on a group-separated
test set. Packaging stops unless all of these checks pass:

- ROC-AUC at least 0.80
- false-block rate at most 2%
- off-task detection recall at least 65%
- uncertainty rate at most 35%

The thresholds are learned from validation data only. Uncertain pages are allowed.
These are minimum engineering gates, not proof of classroom safety. Before broad
deployment, add reviewed examples from real focus sessions across subjects, page
types, age groups, languages, and accessibility needs.

## Data format

Use JSONL with one object per line:

```json
{"goal":"Review cellular respiration","page_text":"Title: Glycolysis lesson ...","label":1,"page_id":"page-123"}
```

`label` is `1` when the page materially helps the goal and `0` when it does not.
Include a stable `page_id`, `canonical_url`, or relationship group whenever possible.
Related rows are kept in one split. Explicit corrections exported by the extension
already use the required core fields, but they should be reviewed before training.

## Train and release

Create an isolated environment and install this package:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -e . pytest
```

Prepare deterministic splits. Use `--holdout-field subject_category` only when the
field is consistent within every relationship group; the splitter rejects leakage.

```bash
python prepare_data.py data/reviewed.jsonl --output-dir artifacts/data
```

Fine-tune the pinned base revision:

```bash
python train.py \
  --train-data artifacts/data/train.jsonl \
  --validation-data artifacts/data/validation.jsonl \
  --output-dir artifacts/focuify-v2
```

Calibrate and run the release gates:

```bash
python evaluate.py \
  --model artifacts/focuify-v2/model \
  --validation-data artifacts/data/validation.jsonl \
  --test-data artifacts/data/test.jsonl \
  --output artifacts/focuify-v2/evaluation.json
```

Only after evaluation exits successfully:

```bash
python export_model.py \
  --model artifacts/focuify-v2/model \
  --output-dir artifacts/focuify-v2/browser

python validate_runtime.py \
  --native-model artifacts/focuify-v2/model \
  --onnx-model artifacts/focuify-v2/browser/model_quantized.onnx \
  --data artifacts/data/validation.jsonl \
  --evaluation artifacts/focuify-v2/evaluation.json

python package_model.py \
  --browser-model artifacts/focuify-v2/browser \
  --evaluation artifacts/focuify-v2/evaluation.json \
  --model-version focuify-relevance-v2.0.0
```

`package_model.py` verifies the release result, copies the quantized model and
tokenizer, records the model hash, and updates the browser decision policy with the
validation-learned thresholds.

## Tests

```bash
pytest
```

The tests cover schema validation, deterministic group separation, calibration, and
the release policy. The root Node test suite separately verifies browser policy,
evidence construction, syntax, and bundled-model integrity.
