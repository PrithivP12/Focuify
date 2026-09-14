# Focuify relevance model

## Model details

- Base model: [`mixedbread-ai/mxbai-rerank-xsmall-v1`](https://huggingface.co/mixedbread-ai/mxbai-rerank-xsmall-v1)
- Source revision: `b5c6e9da73abc3711f593f705371cdbe9e0fe422`
- License: Apache-2.0
- Format: ONNX with dynamic int8 weight quantization
- Model checksum (SHA-256): `b5abfa1fb49eba33f76bfb58ec7cdb41c05c372dc1ae5579679143f6316c8531`
- Token limit used by the extension: 256

This is an export of the original upstream checkpoint. It has not been fine-tuned on Focuify data.

## Intended use

The model scores how well a page supports a short classroom focus goal. Focuify supplies the goal as the query and bounded page evidence as the document. The model runs locally through WebAssembly, and a sigmoid converts its single output logit into a score.

Teacher-managed allow and block lists take priority over the model. Teachers can also choose whether Google Search results are evaluated.

## Validation

The exported int8 model was compared with the original PyTorch checkpoint on a small smoke-test set covering relevant and irrelevant educational pairs. All decisions matched at a zero-logit threshold. The largest observed logit difference was `0.3315`.

This smoke test verifies export behavior; it is not an accuracy benchmark. The model has not passed Focuify's proposed sealed 90% benchmark, so the project does not claim 90% accuracy.

## Limitations

Relevance is subjective and depends on the wording of the goal and the text available on the page. The model may misclassify short, ambiguous, multilingual, image-only, highly technical, or adversarial pages. Dynamic pages may also provide incomplete evidence. Teachers and students should treat blocking decisions as assistance rather than a guarantee.

## Privacy

The model and tokenizer are bundled with the extension. Inference requires no model download, and model inputs are not persisted or sent to a server.
