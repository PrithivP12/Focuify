import http from "node:http";
import { existsSync, renameSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FocusStore } from "./db.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DASHBOARD_ROOT = path.join(ROOT, "teacher-dashboard");
const MAX_BODY_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 60_000;
const requestCounts = new Map();
let lastRateLimitSweep = 0;

export function createFocusServer({
  dbPath = process.env.FOCUS_DB_PATH || defaultDatabasePath(),
  allowedOrigins = defaultAllowedOrigins(),
} = {}) {
  const store = new FocusStore(dbPath);
  const server = http.createServer(async (request, response) => {
    try {
      await handleRequest(request, response, store, allowedOrigins);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(
        response,
        status,
        {
          error: {
            code: error.code || "internal_error",
            message: error.message || "Unexpected server error",
          },
        },
        request,
        allowedOrigins,
      );
    }
  });
  server.focusStore = store;
  return server;
}

async function handleRequest(request, response, store, allowedOrigins) {
  setSecurityHeaders(response, request, allowedOrigins);
  const url = new URL(
    request.url || "/",
    `http://${request.headers.host || "localhost"}`,
  );
  const method = String(request.method || "GET").toUpperCase();
  if (method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (!consumeRateLimit(request, url.pathname))
    throw new HttpError(
      429,
      "rate_limited",
      "Too many requests. Try again shortly.",
    );

  if (url.pathname === "/v1/health" && method === "GET") {
    sendJson(
      response,
      200,
      { ok: true, service: "focuify", time: new Date().toISOString() },
      request,
      allowedOrigins,
    );
    return;
  }
  if (
    url.pathname === "/" ||
    url.pathname === "/teacher" ||
    url.pathname === "/teacher/"
  ) {
    await sendFile(
      response,
      path.join(DASHBOARD_ROOT, "index.html"),
      "text/html; charset=utf-8",
      request,
      allowedOrigins,
    );
    return;
  }
  if (url.pathname === "/teacher/app.js") {
    await sendFile(
      response,
      path.join(DASHBOARD_ROOT, "app.js"),
      "text/javascript; charset=utf-8",
      request,
      allowedOrigins,
    );
    return;
  }
  if (url.pathname === "/teacher/styles.css") {
    await sendFile(
      response,
      path.join(DASHBOARD_ROOT, "styles.css"),
      "text/css; charset=utf-8",
      request,
      allowedOrigins,
    );
    return;
  }
  if (
    url.pathname === "/teacher/focuify-logo.png" ||
    url.pathname === "/teacher/focuify-icon.png"
  ) {
    await sendFile(
      response,
      path.join(DASHBOARD_ROOT, path.basename(url.pathname)),
      "image/png",
      request,
      allowedOrigins,
    );
    return;
  }
  if (!url.pathname.startsWith("/v1/"))
    throw new HttpError(404, "not_found", "Not found");

  const body = ["POST", "PATCH", "PUT", "DELETE"].includes(method)
    ? await readJson(request)
    : {};
  if (url.pathname === "/v1/auth/register" && method === "POST") {
    assertAllowedFields(body, ["email", "name", "password"]);
    const email = normalizeEmail(body.email);
    const name = cleanName(body.name);
    const password = String(body.password || "");
    if (!/^\S+@\S+\.\S+$/.test(email))
      throw new HttpError(400, "invalid_email", "Enter a valid email address.");
    if (name.length < 2)
      throw new HttpError(400, "invalid_name", "Enter your full name.");
    if (password.length < 10 || password.length > 200)
      throw new HttpError(
        400,
        "weak_password",
        "Use a password with at least 10 characters.",
      );
    if (store.getUserByEmail(email))
      throw new HttpError(
        409,
        "email_exists",
        "An account with this email already exists.",
      );
    const user = store.createTeacher({ email, name, password });
    const session = store.issueTeacherSession(user.id);
    sendJson(
      response,
      201,
      { token: session.token, expiresAt: session.expiresAt, user },
      request,
      allowedOrigins,
    );
    return;
  }
  if (url.pathname === "/v1/auth/login" && method === "POST") {
    assertAllowedFields(body, ["email", "password"]);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const user = store.authenticateTeacher(email, password);
    if (!user)
      throw new HttpError(
        401,
        "invalid_credentials",
        "Email or password is incorrect.",
      );
    const session = store.issueTeacherSession(user.id);
    sendJson(
      response,
      200,
      { token: session.token, expiresAt: session.expiresAt, user },
      request,
      allowedOrigins,
    );
    return;
  }
  if (url.pathname === "/v1/join" && method === "POST") {
    assertAllowedFields(body, ["classCode", "name", "deviceId"]);
    const classCode = String(body.classCode || "")
      .trim()
      .toUpperCase();
    const name = cleanName(body.name);
    const deviceId = String(body.deviceId || "").trim();
    if (!/^[A-Z2-9]{6}$/.test(classCode))
      throw new HttpError(
        400,
        "invalid_class_code",
        "Class codes are six letters or numbers.",
      );
    if (name.length < 2)
      throw new HttpError(
        400,
        "invalid_name",
        "Enter a name your teacher will recognize.",
      );
    if (!/^[a-zA-Z0-9._:-]{12,120}$/.test(deviceId))
      throw new HttpError(
        400,
        "invalid_device",
        "This device could not be identified safely.",
      );
    const joined = store.joinStudent({ classCode, name, deviceId });
    if (!joined)
      throw new HttpError(
        404,
        "class_not_found",
        "That class code is not active.",
      );
    const session = store.issueStudentSession(joined.student.id);
    const policy = store.policyForStudent(joined.student.id);
    sendJson(
      response,
      201,
      {
        token: session.token,
        expiresAt: session.expiresAt,
        student: policy.student,
        class: policy.class,
      },
      request,
      allowedOrigins,
    );
    return;
  }

  const session = requireSession(request, store);
  if (url.pathname === "/v1/auth/logout" && method === "POST") {
    assertAllowedFields(body, []);
    const header = String(request.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    store.deleteSession(token);
    sendJson(response, 200, { ok: true }, request, allowedOrigins);
    return;
  }
  if (url.pathname === "/v1/auth/me" && method === "GET") {
    if (session.role !== "teacher")
      throw new HttpError(403, "forbidden", "Teacher access is required.");
    sendJson(
      response,
      200,
      { user: store.getUser(session.user_id) },
      request,
      allowedOrigins,
    );
    return;
  }

  if (session.role === "teacher") {
    if (url.pathname === "/v1/classes" && method === "GET") {
      sendJson(
        response,
        200,
        { classes: store.listClasses(session.user_id) },
        request,
        allowedOrigins,
      );
      return;
    }
    if (url.pathname === "/v1/classes" && method === "POST") {
      assertAllowedFields(body, ["name"]);
      const name = String(body.name || "")
        .trim()
        .replace(/\s+/g, " ");
      if (name.length < 2 || name.length > 100)
        throw new HttpError(
          400,
          "invalid_class_name",
          "Class name must be between 2 and 100 characters.",
        );
      sendJson(
        response,
        201,
        { class: store.createClass(session.user_id, name) },
        request,
        allowedOrigins,
      );
      return;
    }
    const classMatch = url.pathname.match(
      /^\/v1\/classes\/([^/]+)(?:\/(overview|policy|rotate-code|students|students\/([^/]+)))?$/,
    );
    if (classMatch) {
      const classId = decodeURIComponent(classMatch[1]);
      const action = classMatch[2] || "";
      const studentId = classMatch[3] || "";
      if (!store.getClassForTeacher(session.user_id, classId))
        throw new HttpError(404, "class_not_found", "Class not found.");
      if (action === "overview" && method === "GET") {
        sendJson(
          response,
          200,
          store.overview(session.user_id, classId),
          request,
          allowedOrigins,
        );
        return;
      }
      if (action === "policy" && method === "PATCH") {
        assertAllowedFields(body, [
          "enabled",
          "focusGoal",
          "similarityThreshold",
          "searchGuardEnabled",
        ]);
        const enabled = Boolean(body.enabled);
        const focusGoal = String(body.focusGoal || "")
          .trim()
          .slice(0, 220);
        const similarityThreshold = clamp(
          Number(body.similarityThreshold) || 0.5,
          0.1,
          0.9,
        );
        const searchGuardEnabled = Boolean(body.searchGuardEnabled);
        if (enabled && !focusGoal)
          throw new HttpError(
            400,
            "missing_focus_goal",
            "Add a focus goal before enabling the class policy.",
          );
        sendJson(
          response,
          200,
          {
            class: store.updatePolicy(session.user_id, classId, {
              enabled,
              focusGoal,
              similarityThreshold,
              searchGuardEnabled,
            }),
          },
          request,
          allowedOrigins,
        );
        return;
      }
      if (action === "rotate-code" && method === "POST") {
        assertAllowedFields(body, []);
        sendJson(
          response,
          200,
          { class: store.rotateCode(session.user_id, classId) },
          request,
          allowedOrigins,
        );
        return;
      }
      if (action === "students" && method === "DELETE") {
        assertAllowedFields(body, []);
        sendJson(
          response,
          200,
          {
            ok: true,
            removed: store.removeAllStudents(session.user_id, classId),
          },
          request,
          allowedOrigins,
        );
        return;
      }
      if (studentId && method === "DELETE") {
        assertAllowedFields(body, []);
        if (
          !store.removeStudent(
            session.user_id,
            classId,
            decodeURIComponent(studentId),
          )
        )
          throw new HttpError(404, "student_not_found", "Student not found.");
        sendJson(response, 200, { ok: true }, request, allowedOrigins);
        return;
      }
    }
  }

  if (session.role === "student") {
    if (url.pathname === "/v1/student/policy-sync" && method === "GET") {
      const policy = store.policyForStudent(session.student_id);
      if (!policy)
        throw new HttpError(
          404,
          "student_not_found",
          "Student enrollment is no longer active.",
        );
      sendJson(response, 200, policy, request, allowedOrigins);
      return;
    }
    if (url.pathname === "/v1/student/heartbeat" && method === "POST") {
      assertAllowedFields(body, []);
      if (!store.getStudent(session.student_id))
        throw new HttpError(
          404,
          "student_not_found",
          "Student enrollment is no longer active.",
        );
      store.touchStudent(session.student_id);
      sendJson(response, 200, { ok: true }, request, allowedOrigins);
      return;
    }
    if (url.pathname === "/v1/student/status" && method === "POST") {
      assertAllowedFields(body, ["status"]);
      const status = String(body.status || "");
      if (!["focused", "blocked"].includes(status))
        throw new HttpError(
          400,
          "invalid_status",
          "Status must be focused or blocked.",
        );
      const result = store.recordStudentStatus(session.student_id, status);
      if (!result)
        throw new HttpError(
          409,
          "session_inactive",
          "There is no active focus session.",
        );
      sendJson(
        response,
        200,
        { ok: true, status: result.status, updatedAt: result.updatedAt },
        request,
        allowedOrigins,
      );
      return;
    }
    if (url.pathname === "/v1/student/leave" && method === "POST") {
      assertAllowedFields(body, []);
      store.leaveStudent(session.student_id);
      sendJson(response, 200, { ok: true }, request, allowedOrigins);
      return;
    }
  }
  throw new HttpError(404, "not_found", "Not found");
}

function requireSession(request, store) {
  const header = String(request.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const session = store.resolveSession(token);
  if (!session)
    throw new HttpError(401, "unauthorized", "Sign in is required.");
  return session;
}

function setSecurityHeaders(response, request, allowedOrigins) {
  const origin = String(request.headers.origin || "");
  if (allowedOrigins.includes("*"))
    response.setHeader("Access-Control-Allow-Origin", "*");
  else if (origin && allowedOrigins.includes(origin))
    response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization",
  );
  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PATCH,DELETE,OPTIONS",
  );
  response.setHeader("Vary", "Origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' http: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, status, value, request, allowedOrigins) {
  setSecurityHeaders(response, request, allowedOrigins);
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function sendFile(
  response,
  filePath,
  contentType,
  request,
  allowedOrigins,
) {
  try {
    const body = await readFile(filePath);
    setSecurityHeaders(response, request, allowedOrigins);
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.byteLength,
    });
    response.end(body);
  } catch {
    throw new HttpError(404, "not_found", "Dashboard asset not found.");
  }
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY_BYTES)
      throw new HttpError(413, "body_too_large", "Request body is too large.");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Object expected");
    return parsed;
  } catch {
    throw new HttpError(
      400,
      "invalid_json",
      "Request body must be valid JSON.",
    );
  }
}

function consumeRateLimit(request, pathname) {
  const ip = String(request.socket.remoteAddress || "unknown");
  const bucket =
    pathname === "/v1/join"
      ? "join"
      : pathname.startsWith("/v1/auth/")
        ? "auth"
        : "api";
  const key = `${ip}:${bucket}`;
  const timestamp = Date.now();
  if (timestamp - lastRateLimitSweep > RATE_WINDOW_MS) {
    for (const [storedKey, values] of requestCounts) {
      if (!values.some((value) => timestamp - value < RATE_WINDOW_MS))
        requestCounts.delete(storedKey);
    }
    lastRateLimitSweep = timestamp;
  }
  const recent = (requestCounts.get(key) || []).filter(
    (value) => timestamp - value < RATE_WINDOW_MS,
  );
  const limit = bucket === "join" ? 20 : bucket === "auth" ? 30 : 240;
  if (recent.length >= limit) return false;
  recent.push(timestamp);
  requestCounts.set(key, recent);
  return true;
}

function parseOrigins(value) {
  return String(value || "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function defaultAllowedOrigins() {
  const origins = parseOrigins(process.env.ALLOWED_ORIGINS || "*");
  if (process.env.NODE_ENV === "production" && origins.includes("*")) {
    throw new Error(
      "ALLOWED_ORIGINS must list the dashboard and extension origins in production.",
    );
  }
  return origins;
}

function defaultDatabasePath() {
  const currentPath = path.join(ROOT, "data", "focuify.sqlite");
  const legacyPath = path.join(ROOT, "data", "focusforge.sqlite");
  if (!existsSync(currentPath) && existsSync(legacyPath)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(`${legacyPath}${suffix}`))
        renameSync(`${legacyPath}${suffix}`, `${currentPath}${suffix}`);
    }
  }
  return currentPath;
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, 160);
}

function cleanName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function assertAllowedFields(value, allowed) {
  const unexpected = Object.keys(value || {}).filter(
    (key) => !allowed.includes(key),
  );
  if (unexpected.length)
    throw new HttpError(
      400,
      "unexpected_fields",
      "The request contains unsupported fields.",
    );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 8787);
  const server = createFocusServer();
  server.listen(port, host, () => {
    console.log(`Focuify teacher dashboard: http://${host}:${port}/teacher`);
  });
  const shutdown = () => server.close(() => server.focusStore.close());
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
