# Focuify Relevance V2.0.0

Focuify Relevance V2 is a local cross-encoder that estimates whether a webpage can
materially help with a user's current focus goal. It is designed for Focuify's
browser decision, not for chatting, factual question answering, or general content
moderation.

## Model

- Base model: `mixedbread-ai/mxbai-rerank-xsmall-v1`
- Base revision: `b5c6e9da73abc3711f593f705371cdbe9e0fe422`
- Architecture: 12-layer DeBERTa V2 sequence classifier with one relevance logit
- Inputs: focus goal and compact visible page evidence
- Maximum sequence length: 128 tokens
- Browser format: mixed-precision INT8 ONNX, 89,622,982 bytes
- Browser artifact SHA-256: `933c3f72fa2d559daca36e945656c5fbca24dfed08a840b1814ae3dbc1e1260d`

The browser export keeps one sensitive transformer layer in FP32 and dynamically
quantizes the remaining supported embedding and matrix operations. This was selected
by a fixed runtime-accuracy gate, not by weakening the gate after export.

## Training data

Training used 18,314 balanced goal-page pairs from two locally generated synthetic
K–12 distributions. Coverage spans elementary through advanced high school and
includes mathematics, sciences, social sciences, language arts, computing, arts,
language learning, health, and business. Hard cases include low-overlap positives,
wrong-sense keyword matches, educational-sounding distractions, task mismatches,
age and difficulty mismatches, indirect tools, and counterfactual goal/page swaps.

Relationships sharing page identity, exact normalized text, or any supplied matched,
counterfactual, goal-swap, or page-swap identifier were unioned transitively before
splitting. The final development split contained 2,451 validation examples. Two test
distributions remained separate and were required to pass independently.

## Held-out results

Thresholds were chosen from validation data only: scores below `0.3757526086` are
off-task, scores from there to `0.5072778655` are uncertain, and higher scores are
relevant. Focuify allows uncertain pages.

| Test distribution | Rows | ROC-AUC | False blocks | Off-task recall | Uncertain |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original structured test | 1,440 | 1.0000 | 0.28% | 100.00% | 0.35% |
| Independent hard-case test | 995 | 0.9871 | 0.60% | 89.41% | 0.90% |

The release gates required ROC-AUC of at least 0.80, false blocks at most 2%,
off-task recall at least 65%, and uncertainty at most 35% on every test distribution.

## Runtime validation

On 512 validation examples, the quantized browser model had maximum absolute
probability error `0.1037569`, mean absolute error `0.0061322`, and three-way decision
agreement `99.8047%` against the native FP32 checkpoint. The declared gates were
maximum error at most `0.12` and decision agreement at least `99%`.

## Limitations

The evidence is synthetic and English-heavy. Strong held-out synthetic results do
not prove performance on arbitrary websites or every school subject. Page extraction,
multilingual content, adversarial pages, sparse pages, accessibility workflows, and
real-world distribution shift need reviewed evaluation. Explicit user corrections
stay on-device and may be exported for review; they must not be treated as ground
truth without inspection. Focuify fails open if model inference fails.
