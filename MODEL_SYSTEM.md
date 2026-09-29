# Focuify intelligence system

## What is custom

Focuify's intelligence is the complete goal-to-page decision system, not just a name
placed over a downloaded checkpoint. It includes page-evidence extraction, segment
ranking, uncertainty-aware policy, private per-goal correction, reviewed-data export,
fine-tuning, validation-only calibration, held-out evaluation, browser quantization,
artifact hashing, and release gates.

The bundled Focuify Relevance V2 weights passed every release and runtime check on
both retained test distributions. The packager refuses to replace them with a future
candidate that does not pass the same gates; a custom model that performs worse is
not an upgrade.

## Decision path

1. The content script extracts the visible title, description, headings, keywords,
   and useful body text.
2. The extension creates several bounded page views so important evidence is not
   lost at the end of a long page.
3. The on-device cross-encoder scores each view against the focus goal.
4. The strongest score enters a model-specific three-way policy.
5. Clearly off-task pages are paused, uncertain pages stay open, and explicit user
   corrections lower future blocking risk for the same goal.

All page text, inference, and personalization stay in the extension. There is no
telemetry or cloud inference path.

## Known limits

Synthetic benchmarks are useful for finding shortcuts but do not establish real-world
quality. Earlier Focuify fine-tunes achieved perfect in-distribution synthetic results
and then failed an independently generated challenge set. Those checkpoints are not
shipped. Real, consented, reviewed feedback is the most important next dataset.
