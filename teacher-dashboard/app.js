const $ = (id) => document.getElementById(id);
const API_BASE = window.location.origin.replace(/\/$/, "");
const TEACHER_TOKEN_KEY = "focuify_teacher_token";
const LEGACY_TEACHER_TOKEN_KEY = "focusforge_teacher_token";
const legacyToken = localStorage.getItem(LEGACY_TEACHER_TOKEN_KEY);
if (!localStorage.getItem(TEACHER_TOKEN_KEY) && legacyToken)
  localStorage.setItem(TEACHER_TOKEN_KEY, legacyToken);
localStorage.removeItem(LEGACY_TEACHER_TOKEN_KEY);
const state = {
  token: localStorage.getItem(TEACHER_TOKEN_KEY) || "",
  user: null,
  classes: [],
  activeClassId: "",
  overview: null,
  registering: false,
};

function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  return fetch(`${API_BASE}${path}`, { ...options, headers }).then(
    async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data?.error?.message || "Request failed.");
      return data;
    },
  );
}

function setMessage(element, text, error = false) {
  element.textContent = text || "";
  element.classList.toggle("error", error);
}

async function boot() {
  if (!state.token) return showAuth();
  try {
    const me = await api("/v1/auth/me");
    state.user = me.user;
    await showDashboard();
  } catch {
    clearSession();
    showAuth();
  }
}

function showAuth() {
  $("authScreen").classList.remove("hidden");
  $("dashboardScreen").classList.add("hidden");
}

async function showDashboard() {
  $("authScreen").classList.add("hidden");
  $("dashboardScreen").classList.remove("hidden");
  $("teacherIdentity").textContent = state.user
    ? `${state.user.name} · ${state.user.email}`
    : "";
  await loadClasses();
}

async function loadClasses() {
  const data = await api("/v1/classes");
  state.classes = data.classes || [];
  if (
    !state.activeClassId ||
    !state.classes.some((item) => item.id === state.activeClassId)
  )
    state.activeClassId = state.classes[0]?.id || "";
  renderClassList();
  renderWorkspace();
  if (state.activeClassId) await loadOverview();
}

async function loadOverview() {
  if (!state.activeClassId) return;
  state.overview = await api(
    `/v1/classes/${encodeURIComponent(state.activeClassId)}/overview`,
  );
  renderWorkspace();
}

function renderClassList() {
  const list = $("classList");
  if (!state.classes.length) {
    list.innerHTML = '<p class="muted">No classes yet.</p>';
    return;
  }
  list.innerHTML = state.classes
    .map(
      (item) =>
        `<button class="class-item ${item.id === state.activeClassId ? "active" : ""}" data-class-id="${escapeHtml(item.id)}" type="button"><strong>${escapeHtml(item.name)}</strong><span>Code ${escapeHtml(item.classCode)}</span></button>`,
    )
    .join("");
  list.querySelectorAll("[data-class-id]").forEach((button) =>
    button.addEventListener("click", async () => {
      state.activeClassId = button.dataset.classId;
      renderClassList();
      await loadOverview();
    }),
  );
}

function renderWorkspace() {
  const empty = $("emptyState");
  const view = $("classView");
  if (!state.activeClassId || !state.overview) {
    empty.classList.remove("hidden");
    view.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  view.classList.remove("hidden");
  const data = state.overview;
  const item = data.class;
  $("classTitle").textContent = item.name;
  $("classUpdated").textContent =
    `Policy updated ${relativeTime(item.policy.updatedAt || item.updatedAt)}`;
  $("joinCode").textContent = item.classCode;
  $("policyEnabled").checked = Boolean(item.policy.enabled);
  $("searchGuardEnabled").checked = Boolean(item.policy.searchGuardEnabled);
  $("policyGoal").value = item.policy.focusGoal || "";
  $("policyThreshold").value = String(item.policy.similarityThreshold || 0.5);
  updateThresholdLabel();
  $("connectedStudents").textContent = String(data.totals.connected || 0);
  $("focusedStudents").textContent = String(data.totals.focused || 0);
  $("blockedStudents").textContent = String(data.totals.blocked || 0);
  $("disconnectedStudents").textContent = String(data.totals.disconnected || 0);
  $("blockedAttempts").textContent = String(data.totals.blockedAttempts || 0);
  $("focusPercentage").textContent = Number.isFinite(
    data.totals.focusPercentage,
  )
    ? `${data.totals.focusPercentage}%`
    : "—";
  renderRoster(data.students || []);
}

function renderRoster(students) {
  $("rosterCount").textContent = `${students.length} enrolled`;
  $("removeAllStudentsButton").disabled = students.length === 0;
  $("rosterBody").innerHTML = students.length
    ? students
        .map(
          (student) =>
            `<tr><td><strong>${escapeHtml(student.name)}</strong></td><td><span class="status-dot ${statusClass(student.status)}">${escapeHtml(statusLabel(student.status))}</span></td><td>${escapeHtml(relativeTime(student.lastSeenAt))}</td><td><button class="remove-student" data-student-id="${escapeHtml(student.id)}" type="button">Remove</button></td></tr>`,
        )
        .join("")
    : '<tr><td colspan="4" class="muted">No students have joined yet.</td></tr>';
  $("rosterBody")
    .querySelectorAll("[data-student-id]")
    .forEach((button) =>
      button.addEventListener("click", async () => {
        if (
          !window.confirm(
            "Remove this student from the class? They can rejoin with the code.",
          )
        )
          return;
        try {
          await api(
            `/v1/classes/${encodeURIComponent(state.activeClassId)}/students/${encodeURIComponent(button.dataset.studentId)}`,
            { method: "DELETE" },
          );
          await loadOverview();
        } catch (error) {
          window.alert(error.message);
        }
      }),
    );
}

async function removeAllStudents() {
  const count = state.overview?.students?.length || 0;
  if (
    !count ||
    !window.confirm(
      `Remove all ${count} students from this class? They can rejoin with the class code.`,
    )
  )
    return;
  const button = $("removeAllStudentsButton");
  button.disabled = true;
  try {
    await api(
      `/v1/classes/${encodeURIComponent(state.activeClassId)}/students`,
      { method: "DELETE" },
    );
    await loadOverview();
  } catch (error) {
    button.disabled = false;
    window.alert(error.message);
  }
}

async function submitAuth(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const payload = { email: form.get("email"), password: form.get("password") };
  if (state.registering) payload.name = form.get("name");
  setMessage($("authMessage"), "Working…");
  try {
    const data = await api(
      state.registering ? "/v1/auth/register" : "/v1/auth/login",
      { method: "POST", body: JSON.stringify(payload) },
    );
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem(TEACHER_TOKEN_KEY, state.token);
    formElement.reset();
    setMessage($("authMessage"), "");
    await showDashboard();
  } catch (error) {
    setMessage($("authMessage"), error.message, true);
  }
}

async function createClass(event) {
  event.preventDefault();
  const name = $("newClassName").value.trim();
  try {
    const data = await api("/v1/classes", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    state.activeClassId = data.class.id;
    $("newClassForm").classList.add("hidden");
    $("newClassName").value = "";
    await loadClasses();
  } catch (error) {
    setMessage($("classMessage"), error.message, true);
  }
}

async function savePolicy(event) {
  event.preventDefault();
  setMessage($("policyMessage"), "Saving…");
  try {
    await api(`/v1/classes/${encodeURIComponent(state.activeClassId)}/policy`, {
      method: "PATCH",
      body: JSON.stringify({
        enabled: $("policyEnabled").checked,
        searchGuardEnabled: $("searchGuardEnabled").checked,
        focusGoal: $("policyGoal").value.trim(),
        similarityThreshold: Number($("policyThreshold").value),
      }),
    });
    setMessage($("policyMessage"), "Policy saved and queued for student sync.");
    await loadOverview();
  } catch (error) {
    setMessage($("policyMessage"), error.message, true);
  }
}

async function rotateCode() {
  if (
    !window.confirm(
      "Rotate the code? Students using the old code stay enrolled, but new joins need the new code.",
    )
  )
    return;
  try {
    await api(
      `/v1/classes/${encodeURIComponent(state.activeClassId)}/rotate-code`,
      { method: "POST" },
    );
    setMessage($("codeMessage"), "New join code created.");
    await loadOverview();
  } catch (error) {
    setMessage($("codeMessage"), error.message, true);
  }
}

function setAuthMode(registering) {
  state.registering = registering;
  $("registerTab").classList.toggle("active", registering);
  $("loginTab").classList.toggle("active", !registering);
  $("registerTab").setAttribute("aria-selected", String(registering));
  $("loginTab").setAttribute("aria-selected", String(!registering));
  $("nameField").classList.toggle("hidden", !registering);
  $("teacherName").required = registering;
  $("authSubmit").textContent = registering
    ? "Create teacher account"
    : "Sign in";
  $("teacherPassword").autocomplete = registering
    ? "new-password"
    : "current-password";
  setMessage($("authMessage"), "");
}

function clearSession() {
  state.token = "";
  state.user = null;
  localStorage.removeItem(TEACHER_TOKEN_KEY);
  localStorage.removeItem(LEGACY_TEACHER_TOKEN_KEY);
}
function statusClass(value) {
  return ["focused", "blocked", "connecting", "disconnected"].includes(value)
    ? value
    : "ended";
}
function statusLabel(value) {
  return value === "session ended"
    ? "Session ended"
    : value
      ? value[0].toUpperCase() + value.slice(1)
      : "Connecting";
}
function relativeTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
function updateThresholdLabel() {
  const value = Number($("policyThreshold").value);
  $("policyThresholdValue").textContent =
    value >= 0.48 ? "Strict" : value <= 0.3 ? "Lenient" : "Balanced";
}
function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

$("loginTab").addEventListener("click", () => setAuthMode(false));
$("registerTab").addEventListener("click", () => setAuthMode(true));
$("authForm").addEventListener("submit", submitAuth);
$("newClassButton").addEventListener("click", () => {
  $("newClassForm").classList.remove("hidden");
  $("newClassName").focus();
});
$("emptyCreateButton").addEventListener("click", () => {
  $("newClassForm").classList.remove("hidden");
  $("newClassName").focus();
});
$("cancelNewClassButton").addEventListener("click", () =>
  $("newClassForm").classList.add("hidden"),
);
$("newClassForm").addEventListener("submit", createClass);
$("policyForm").addEventListener("submit", savePolicy);
$("policyThreshold").addEventListener("input", updateThresholdLabel);
$("rotateCodeButton").addEventListener("click", rotateCode);
$("removeAllStudentsButton").addEventListener(
  "click",
  () => void removeAllStudents(),
);
$("refreshButton").addEventListener("click", () => void loadOverview());
$("signOutButton").addEventListener("click", async () => {
  try {
    await api("/v1/auth/logout", { method: "POST" });
  } catch {}
  clearSession();
  showAuth();
});
setInterval(() => {
  if (
    state.token &&
    state.activeClassId &&
    !$("dashboardScreen").classList.contains("hidden")
  )
    void loadOverview().catch(() => {});
}, 10_000);
setAuthMode(false);
void boot();
