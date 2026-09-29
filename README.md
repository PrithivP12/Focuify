# Focuify

The standalone Chrome extension is in [`focuify`](focuify/).

The extension runs its relevance model locally. The custom-model training,
evaluation, quantization, and release-gating code is in [`modeling`](modeling/).

```bash
npm test
npm run check
```

See the two directory READMEs for installation and model-development details.
