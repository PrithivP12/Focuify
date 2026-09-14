# Focuify

Focuify is a classroom focus platform with a student Chrome extension and a teacher dashboard. Teachers create a class, share a join code, set a focus goal, and turn page blocking on or off. Students join from the extension without an email account.

## What it includes

- Local page relevance checks using a bundled cross-encoder
- Teacher-controlled focus mode and Google Search blocking
- YouTube checks based on the video title, channel, and description
- Teacher allow/block domain overrides
- Student settings for theme, text size, contrast, and reduced motion
- A live roster with focused, blocked, and disconnected states
- Individual and bulk student removal

## Privacy

Page content is evaluated inside the extension. Titles, text, URLs, search queries, and model inputs are not saved to Chrome storage or sent to the teacher server. The server receives only enrollment details, authentication tokens, and the student's current `focused` or `blocked` state.

The extension stores a small set of settings, class enrollment data, and bounded model performance totals. Blocked-page destinations use memory-only session storage and disappear when the browser session ends.

## Run the teacher dashboard

Node 22.5 or newer is required because the server uses `node:sqlite`.

```sh
npm start
```

Open `http://localhost:8787/teacher`.

For student Chromebooks outside the teacher's computer, deploy the server at a reachable HTTPS address and enter that address in the extension. In production, set `NODE_ENV=production`, `FOCUS_DB_PATH`, and a comma-separated `ALLOWED_ORIGINS` list.

## Build the student extension

```sh
npm run build
```

In Chrome or Chromium, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `dist/extension`.

The build contains the student extension and its local model. It does not include the teacher server, dashboard, tests, or development database. Chrome 116 or newer is required.

## Model

This repository bundles an int8 ONNX export of the original Apache-2.0 [`mixedbread-ai/mxbai-rerank-xsmall-v1`](https://huggingface.co/mixedbread-ai/mxbai-rerank-xsmall-v1) checkpoint. It is not the experimental Focuify fine-tune and does not make a 90% accuracy claim. See [MODEL_CARD.md](MODEL_CARD.md) for the exact revision, checksum, validation, and limitations.

## Validate the project

```sh
npm run check
npm test
npm run build
```

The automated tests cover the teacher/student API flow, authorization, storage boundaries, settings persistence, request validation, page evidence limits, ranking requests, and extension permissions.
