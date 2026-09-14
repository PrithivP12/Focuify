import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
} from "../vendor/transformers.min.js";

const MAX_DOCUMENTS = 8;
const MAX_QUERY_CHARS = 360;
const MAX_DOCUMENT_CHARS = 2400;
const MANIFEST_URL = new URL("model-manifest.json", import.meta.url);

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL("./", import.meta.url).href;
env.useBrowserCache = false;
env.useFSCache = false;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = new URL("../vendor/", import.meta.url).href;

let runtimePromise;
let queue = Promise.resolve();

function readField(value, snakeName, camelName) {
  return value?.[snakeName] ?? value?.[camelName];
}

function validateManifest(value) {
  const manifest = {
    schemaVersion: Number(readField(value, "schema_version", "schemaVersion")),
    modelId: String(readField(value, "model_id", "modelId") || ""),
    modelVersion: String(
      readField(value, "model_version", "modelVersion") || "",
    ),
    modelPath: String(readField(value, "model_path", "modelPath") || ""),
    modelSha256: String(
      readField(value, "model_sha256", "modelSha256") || "",
    ).toLowerCase(),
    dtype: String(value?.dtype || ""),
    scoreTransform: String(
      readField(value, "score_transform", "scoreTransform") || "",
    ),
    maxLength: Number(readField(value, "max_length", "maxLength")),
    status: String(value?.status || ""),
  };
  if (manifest.schemaVersion !== 1 || manifest.status !== "ready")
    throw new Error("The bundled Focuify relevance model is not installed.");
  if (
    !manifest.modelId ||
    !manifest.modelVersion ||
    manifest.modelPath !== "model"
  )
    throw new Error("The bundled model manifest is invalid.");
  if (
    !/^[a-f0-9]{64}$/.test(manifest.modelSha256) ||
    manifest.dtype !== "q8" ||
    manifest.scoreTransform !== "sigmoid"
  ) {
    throw new Error("The bundled model manifest failed validation.");
  }
  if (
    !Number.isInteger(manifest.maxLength) ||
    manifest.maxLength < 32 ||
    manifest.maxLength > 512
  ) {
    throw new Error("The bundled model input limit is invalid.");
  }
  return manifest;
}

async function fetchManifest() {
  const response = await fetch(MANIFEST_URL, { cache: "no-store" });
  if (!response.ok)
    throw new Error("The bundled model manifest could not be read.");
  return validateManifest(await response.json());
}

async function loadRuntimeOnce() {
  const manifest = await fetchManifest();
  const started = performance.now();
  const options = { local_files_only: true };
  const tokenizer = await AutoTokenizer.from_pretrained(
    manifest.modelPath,
    options,
  );
  const model = await AutoModelForSequenceClassification.from_pretrained(
    manifest.modelPath,
    {
      ...options,
      device: "wasm",
      dtype: manifest.dtype,
    },
  );
  return {
    manifest,
    tokenizer,
    model,
    loadDurationMs: performance.now() - started,
  };
}

async function loadRuntime() {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const failures = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await loadRuntimeOnce();
      } catch (error) {
        failures.push(String(error?.message || error));
      }
    }
    throw new Error(
      `Local relevance model failed to load after one retry: ${failures.at(-1)}`,
    );
  })().catch((error) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

function validateRequest(query, documents) {
  if (
    typeof query !== "string" ||
    !query.trim() ||
    query.length > MAX_QUERY_CHARS
  )
    throw new Error("Invalid ranking query.");
  if (
    !Array.isArray(documents) ||
    !documents.length ||
    documents.length > MAX_DOCUMENTS
  )
    throw new Error("Invalid ranking document batch.");
  if (
    documents.some(
      (value) =>
        typeof value !== "string" ||
        !value.trim() ||
        value.length > MAX_DOCUMENT_CHARS,
    )
  ) {
    throw new Error("Invalid ranking document.");
  }
}

function sigmoid(value) {
  return value >= 0
    ? 1 / (1 + Math.exp(-value))
    : Math.exp(value) / (1 + Math.exp(value));
}

async function rank({ query, documents }) {
  validateRequest(query, documents);
  const { manifest, tokenizer, model, loadDurationMs } = await loadRuntime();
  const inputs = tokenizer(new Array(documents.length).fill(query), {
    text_pair: documents,
    padding: true,
    truncation: true,
    max_length: manifest.maxLength,
  });
  const started = performance.now();
  const { logits } = await model(inputs);
  const durationMs = performance.now() - started;
  const values = Array.from(logits?.data || []);
  if (
    values.length !== documents.length ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("The local relevance model returned invalid logits.");
  }
  return {
    scores: values.map(sigmoid),
    modelVersion: manifest.modelVersion,
    backend: "wasm",
    durationMs,
    loadDurationMs,
  };
}

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      self.postMessage({ id: data.id, ok: true, ...(await rank(data)) });
    } catch (error) {
      self.postMessage({
        id: data.id,
        ok: false,
        error: String(error?.message || error),
      });
    }
  });
};
