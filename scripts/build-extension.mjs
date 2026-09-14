import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist", "extension");
const entries = [
  "manifest.json",
  "icon.png",
  "focuify-logo.png",
  "popup.html",
  "popup.css",
  "popup.js",
  "blocked.html",
  "blocked.css",
  "blocked.js",
  "content_script.js",
  "service_worker.js",
  "keywordUtils.js",
  "local-model",
  "vendor",
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all(
  entries.map((entry) =>
    cp(path.join(root, entry), path.join(output, entry), { recursive: true }),
  ),
);
console.log(`Focuify student extension built at ${output}`);
