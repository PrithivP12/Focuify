# Focuify

Focuify is a standalone Chrome extension that keeps browsing aligned with a focus goal. It checks page content locally, blocks pages that do not match the goal, and supports personal allow and block lists.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome or Chromium.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the `focuify` folder.

Chrome 116 or newer is required.

## Privacy

Page text and model inputs stay inside the extension. Focuify does not use a server or send browsing activity anywhere.

## Local intelligence

Relevance scoring uses Focuify Relevance V2, a custom fine-tune of
[`mixedbread-ai/mxbai-rerank-xsmall-v1`](https://huggingface.co/mixedbread-ai/mxbai-rerank-xsmall-v1)
at revision `b5c6e9da73abc3711f593f705371cdbe9e0fe422`. The mixed-precision
INT8 ONNX model and its license are stored in `local-model/model`. The release
evidence and model card are in `modeling/releases/focuify-relevance-v2.0.0`.

Focuify scores several independent views of a page instead of trusting one long
text dump. A calibrated three-way policy marks a page as relevant, uncertain, or
off-task; uncertain pages stay open. If a user explicitly marks a blocked page as
useful, that correction is stored only on the device and can only make the matching
goal more lenient. Corrections can be exported from Settings as JSONL for reviewed
future training.

The repository includes the complete fine-tuning pipeline. A candidate cannot be
packaged into the extension unless it passes held-out false-block, off-task recall,
uncertainty, ROC-AUC, and browser-runtime agreement gates. V2 passed those checks on
both retained test distributions; the model card documents the results and limits.
