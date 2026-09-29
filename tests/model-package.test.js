import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MODEL_POLICY } from "../focuify/modelPolicy.js";

const root = new URL("../focuify/local-model/", import.meta.url);

test("the bundled model matches its signed manifest entry", async () => {
  const manifest = JSON.parse(await readFile(new URL("model-manifest.json", root)));
  const model = await readFile(
    new URL(`${manifest.model_path}/${manifest.model_file}`, root),
  );
  assert.equal(createHash("sha256").update(model).digest("hex"), manifest.model_sha256);
  assert.equal(manifest.status, "ready");
  assert.equal(manifest.dtype, "q8");
  assert.ok(manifest.block_threshold < manifest.threshold);
  assert.equal(MODEL_POLICY.blockThreshold, manifest.block_threshold);
  assert.equal(MODEL_POLICY.allowThreshold, manifest.threshold);
});
