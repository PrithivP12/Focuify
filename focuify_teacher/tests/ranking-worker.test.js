import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

test("ranking worker validates, serializes, retries once, reuses the bundled model, and returns probabilities", async () => {
  const output = [];
  let tokenizerLoads = 0;
  let modelAttempts = 0;
  let active = 0;
  let peak = 0;
  const source = (
    await readFile(
      new URL("../local-model/ranking-worker.js", import.meta.url),
      "utf8",
    )
  )
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];\s*/, "")
    .replaceAll(
      "import.meta.url",
      '"https://extension.test/local-model/ranking-worker.js"',
    );
  const manifest = {
    schema_version: 1,
    model_id: "focuify-relevance-cross-encoder",
    model_version: "v4-test",
    model_path: "model",
    model_sha256: "a".repeat(64),
    dtype: "q8",
    score_transform: "sigmoid",
    max_length: 256,
    status: "ready",
  };
  const tokenizer = (queries, options) => {
    assert.equal(queries.length, options.text_pair.length);
    return { input_ids: queries };
  };
  const model = async (inputs) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return {
      logits: {
        data: Float32Array.from(
          inputs.input_ids.map((_, index) => (index ? 2 : -2)),
        ),
      },
    };
  };
  const context = vm.createContext({
    URL,
    performance,
    setImmediate,
    fetch: async () => ({ ok: true, json: async () => manifest }),
    env: { backends: { onnx: { wasm: {} } } },
    AutoTokenizer: {
      from_pretrained: async () => {
        tokenizerLoads += 1;
        return tokenizer;
      },
    },
    AutoModelForSequenceClassification: {
      from_pretrained: async () => {
        modelAttempts += 1;
        if (modelAttempts === 1) throw new Error("first load failed");
        return model;
      },
    },
    self: { postMessage: (value) => output.push(value) },
  });
  vm.runInContext(source, context);
  context.self.onmessage({
    data: { id: 1, query: "goal", documents: ["irrelevant", "relevant"] },
  });
  context.self.onmessage({
    data: { id: 2, query: "goal", documents: ["relevant"] },
  });
  context.self.onmessage({
    data: { id: 3, query: "", documents: ["invalid"] },
  });
  await vm.runInContext("queue", context);
  assert.equal(output.length, 3);
  assert.equal(output[0].ok, true);
  assert.ok(Math.abs(output[0].scores[0] - 0.1192029) < 0.00001);
  assert.ok(Math.abs(output[0].scores[1] - 0.8807971) < 0.00001);
  assert.equal(output[0].modelVersion, "v4-test");
  assert.equal(output[2].ok, false);
  assert.match(output[2].error, /Invalid/);
  assert.equal(peak, 1);
  assert.equal(tokenizerLoads, 2);
  assert.equal(modelAttempts, 2);
});
