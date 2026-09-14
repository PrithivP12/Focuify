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

## Local model

Relevance scoring uses a bundled int8 ONNX export of [`mixedbread-ai/mxbai-rerank-xsmall-v1`](https://huggingface.co/mixedbread-ai/mxbai-rerank-xsmall-v1) at revision `b5c6e9da73abc3711f593f705371cdbe9e0fe422`. The model and its license are stored in `local-model/model`.
