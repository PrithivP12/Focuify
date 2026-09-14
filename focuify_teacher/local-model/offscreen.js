let worker;
let nextId = 0;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("ranking-worker.js", import.meta.url), {
    type: "module",
  });
  worker.onmessage = ({ data }) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(data.id);
    entry.respond(data);
  };
  worker.onerror = () => failWorker("Local inference worker failed to start.");
  return worker;
}
function failWorker(error) {
  worker?.terminate();
  worker = null;
  for (const { respond, timer } of pending.values()) {
    clearTimeout(timer);
    respond({ ok: false, error });
  }
  pending.clear();
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "focuify-text-ranking") return false;
  if (
    sender.id !== chrome.runtime.id ||
    sender.tab ||
    (sender.url && sender.url !== chrome.runtime.getURL("service_worker.js"))
  )
    return false;
  const id = ++nextId;
  const timer = setTimeout(
    () => failWorker("The bundled local model timed out."),
    240000,
  );
  pending.set(id, { respond, timer });
  try {
    getWorker().postMessage({ ...message, id });
  } catch (error) {
    failWorker(String(error.message || error));
  }
  return true;
});
