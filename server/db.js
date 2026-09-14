import { DatabaseSync } from "node:sqlite";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

const CLASS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const AUTH_SESSION_DAYS = 30;
const ANALYTICS_RETENTION_DAYS = 90;
const INACTIVE_STUDENT_RETENTION_DAYS = 90;
const CONNECTED_WINDOW_MS = 90_000;
const STUDENT_STATUSES = new Set(["connecting", "focused", "blocked"]);
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

export class FocusStore {
  constructor(dbPath = ":memory:") {
    if (dbPath !== ":memory:")
      mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS classes (
        id TEXT PRIMARY KEY,
        teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        class_code TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 0,
        focus_goal TEXT NOT NULL DEFAULT '',
        similarity_threshold REAL NOT NULL DEFAULT 0.5,
        search_guard_enabled INTEGER NOT NULL DEFAULT 0,
        policy_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        device_id TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(class_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK(role IN ('teacher', 'student')),
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.migratePrivacySchema();
    this.purgeExpiredData();
  }

  migratePrivacySchema() {
    const previousVersion = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version || 0,
    );
    this.db.exec("PRAGMA secure_delete = ON");
    const classColumns = this.db.prepare("PRAGMA table_info(classes)").all();
    if (
      !classColumns.some((column) => column.name === "search_guard_enabled")
    ) {
      this.db.exec(
        "ALTER TABLE classes ADD COLUMN search_guard_enabled INTEGER NOT NULL DEFAULT 0",
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS focus_sessions (
        id TEXT PRIMARY KEY,
        class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        focus_goal TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        total_block_events INTEGER NOT NULL DEFAULT 0,
        final_focus_percentage REAL,
        max_connected INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_focus_session_per_class
        ON focus_sessions(class_id) WHERE active = 1;
      CREATE INDEX IF NOT EXISTS focus_sessions_class_time
        ON focus_sessions(class_id, started_at DESC);
      CREATE TABLE IF NOT EXISTS student_session_status (
        session_id TEXT NOT NULL REFERENCES focus_sessions(id) ON DELETE CASCADE,
        student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('connecting', 'focused', 'blocked')),
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(session_id, student_id)
      );
      DROP TABLE IF EXISTS events;
      PRAGMA user_version = 5;
    `);
    if (previousVersion < 5) {
      this.db
        .prepare(
          "UPDATE classes SET similarity_threshold = ? WHERE similarity_threshold = 0.35",
        )
        .run(DEFAULT_SIMILARITY_THRESHOLD);
    }
    const statusColumns = this.db
      .prepare("PRAGMA table_info(student_session_status)")
      .all();
    if (statusColumns.some((column) => column.name === "blocked_count")) {
      this.db.exec(`
        ALTER TABLE student_session_status RENAME TO student_session_status_legacy;
        CREATE TABLE student_session_status (
          session_id TEXT NOT NULL REFERENCES focus_sessions(id) ON DELETE CASCADE,
          student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('connecting', 'focused', 'blocked')),
          last_seen_at TEXT NOT NULL,
          PRIMARY KEY(session_id, student_id)
        );
        INSERT INTO student_session_status (session_id, student_id, status, last_seen_at)
          SELECT session_id, student_id, status, last_seen_at FROM student_session_status_legacy;
        DROP TABLE student_session_status_legacy;
      `);
    }
    if (previousVersion < 4) {
      const hasSequence = this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
        )
        .get();
      if (hasSequence)
        this.db
          .prepare("DELETE FROM sqlite_sequence WHERE name = 'events'")
          .run();
      this.db.exec("VACUUM");
    }
    const enabledClasses = this.db
      .prepare(
        "SELECT id, focus_goal, updated_at FROM classes WHERE enabled = 1",
      )
      .all();
    for (const classRow of enabledClasses) {
      if (!this.getActiveFocusSession(classRow.id))
        this.startFocusSession(
          classRow.id,
          classRow.focus_goal,
          classRow.updated_at || now(),
        );
    }
  }

  purgeExpiredData(referenceTime = Date.now()) {
    const nowIso = new Date(referenceTime).toISOString();
    const analyticsCutoff = new Date(
      referenceTime - ANALYTICS_RETENTION_DAYS * 86_400_000,
    ).toISOString();
    const studentCutoff = new Date(
      referenceTime - INACTIVE_STUDENT_RETENTION_DAYS * 86_400_000,
    ).toISOString();
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso);
    this.db
      .prepare("DELETE FROM focus_sessions WHERE active = 0 AND ended_at < ?")
      .run(analyticsCutoff);
    this.db
      .prepare("DELETE FROM students WHERE active = 0 AND last_seen_at < ?")
      .run(studentCutoff);
  }

  close() {
    this.db.close();
  }

  createTeacher({ email, name, password }) {
    const id = randomUUID();
    const createdAt = now();
    const salt = randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);
    this.db
      .prepare(
        "INSERT INTO users (id, email, name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, email, name, passwordHash, salt, createdAt);
    return this.getUser(id);
  }

  getUser(id) {
    const row = this.db
      .prepare("SELECT id, email, name, created_at FROM users WHERE id = ?")
      .get(id);
    return row ? mapUser(row) : null;
  }

  getUserByEmail(email) {
    return (
      this.db.prepare("SELECT * FROM users WHERE email = ?").get(email) || null
    );
  }

  authenticateTeacher(email, password) {
    const row = this.getUserByEmail(email);
    if (!row || !verifyPassword(password, row.password_salt, row.password_hash))
      return null;
    return mapUser(row);
  }

  issueTeacherSession(userId) {
    return this.issueSession({ role: "teacher", userId });
  }

  issueStudentSession(studentId) {
    this.db.prepare("DELETE FROM sessions WHERE student_id = ?").run(studentId);
    return this.issueSession({ role: "student", studentId });
  }

  issueSession({ role, userId = null, studentId = null }) {
    this.purgeExpiredData();
    const token = randomBytes(32).toString("base64url");
    const createdAt = now();
    const expiresAt = new Date(
      Date.now() + AUTH_SESSION_DAYS * 86_400_000,
    ).toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions (token_hash, role, user_id, student_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(hashToken(token), role, userId, studentId, expiresAt, createdAt);
    return { token, expiresAt };
  }

  resolveSession(token) {
    if (!token) return null;
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE token_hash = ?")
      .get(hashToken(token));
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.db
        .prepare("DELETE FROM sessions WHERE token_hash = ?")
        .run(row.token_hash);
      return null;
    }
    return row;
  }

  deleteSession(token) {
    if (token)
      this.db
        .prepare("DELETE FROM sessions WHERE token_hash = ?")
        .run(hashToken(token));
  }

  createClass(teacherId, name) {
    const id = randomUUID();
    const createdAt = now();
    const classCode = this.generateClassCode();
    this.db
      .prepare(
        "INSERT INTO classes (id, teacher_id, name, class_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, teacherId, name, classCode, createdAt, createdAt);
    return this.getClassForTeacher(teacherId, id);
  }

  listClasses(teacherId) {
    return this.db
      .prepare(
        "SELECT * FROM classes WHERE teacher_id = ? ORDER BY created_at DESC",
      )
      .all(teacherId)
      .map(mapClass);
  }

  getClassForTeacher(teacherId, classId) {
    const row = this.db
      .prepare("SELECT * FROM classes WHERE id = ? AND teacher_id = ?")
      .get(classId, teacherId);
    return row ? mapClass(row) : null;
  }

  findClassByCode(code) {
    return (
      this.db
        .prepare("SELECT * FROM classes WHERE class_code = ?")
        .get(String(code || "").toUpperCase()) || null
    );
  }

  updatePolicy(
    teacherId,
    classId,
    { enabled, focusGoal, similarityThreshold, searchGuardEnabled },
  ) {
    const current = this.db
      .prepare("SELECT * FROM classes WHERE id = ? AND teacher_id = ?")
      .get(classId, teacherId);
    if (!current) return null;
    const updatedAt = now();
    this.db
      .prepare(
        `UPDATE classes SET enabled = ?, focus_goal = ?, similarity_threshold = ?,
      search_guard_enabled = ?, policy_version = policy_version + 1, updated_at = ?
      WHERE id = ? AND teacher_id = ?`,
      )
      .run(
        enabled ? 1 : 0,
        focusGoal,
        similarityThreshold,
        searchGuardEnabled ? 1 : 0,
        updatedAt,
        classId,
        teacherId,
      );
    const activeSession = this.getActiveFocusSession(classId);
    if (enabled && !activeSession)
      this.startFocusSession(classId, focusGoal, updatedAt);
    else if (enabled && activeSession)
      this.db
        .prepare("UPDATE focus_sessions SET focus_goal = ? WHERE id = ?")
        .run(focusGoal, activeSession.id);
    else if (!enabled && activeSession)
      this.endFocusSession(activeSession.id, updatedAt);
    return this.getClassForTeacher(teacherId, classId);
  }

  startFocusSession(classId, focusGoal, startedAt = now()) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO focus_sessions (id, class_id, focus_goal, started_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, classId, focusGoal, startedAt);
    return this.getActiveFocusSession(classId);
  }

  endFocusSession(sessionId, endedAt = now()) {
    const rows = this.db
      .prepare(
        "SELECT status, last_seen_at FROM student_session_status WHERE session_id = ?",
      )
      .all(sessionId);
    const cutoff = Date.now() - CONNECTED_WINDOW_MS;
    const connected = rows.filter(
      (row) => Date.parse(row.last_seen_at) >= cutoff,
    );
    const focused = connected.filter((row) => row.status === "focused").length;
    const blocked = connected.filter((row) => row.status === "blocked").length;
    const denominator = focused + blocked;
    const percentage = denominator
      ? Math.round((focused / denominator) * 1000) / 10
      : null;
    this.db
      .prepare(
        "UPDATE focus_sessions SET active = 0, ended_at = ?, final_focus_percentage = ? WHERE id = ?",
      )
      .run(endedAt, percentage, sessionId);
    this.db
      .prepare("DELETE FROM student_session_status WHERE session_id = ?")
      .run(sessionId);
  }

  getActiveFocusSession(classId) {
    return (
      this.db
        .prepare(
          "SELECT * FROM focus_sessions WHERE class_id = ? AND active = 1",
        )
        .get(classId) || null
    );
  }

  getLatestFocusSession(classId) {
    return (
      this.db
        .prepare(
          "SELECT * FROM focus_sessions WHERE class_id = ? ORDER BY started_at DESC LIMIT 1",
        )
        .get(classId) || null
    );
  }

  rotateCode(teacherId, classId) {
    if (!this.getClassForTeacher(teacherId, classId)) return null;
    const classCode = this.generateClassCode();
    this.db
      .prepare(
        "UPDATE classes SET class_code = ?, updated_at = ? WHERE id = ? AND teacher_id = ?",
      )
      .run(classCode, now(), classId, teacherId);
    return this.getClassForTeacher(teacherId, classId);
  }

  removeStudent(teacherId, classId, studentId) {
    if (!this.getClassForTeacher(teacherId, classId)) return false;
    const result = this.db
      .prepare("DELETE FROM students WHERE id = ? AND class_id = ?")
      .run(studentId, classId);
    return Number(result.changes || 0) > 0;
  }

  removeAllStudents(teacherId, classId) {
    if (!this.getClassForTeacher(teacherId, classId)) return null;
    const result = this.db
      .prepare("DELETE FROM students WHERE class_id = ?")
      .run(classId);
    return Number(result.changes || 0);
  }

  joinStudent({ classCode, name, deviceId }) {
    const classRow = this.findClassByCode(classCode);
    if (!classRow) return null;
    const timestamp = now();
    let student = this.db
      .prepare("SELECT * FROM students WHERE class_id = ? AND device_id = ?")
      .get(classRow.id, deviceId);
    if (student) {
      this.db
        .prepare(
          "UPDATE students SET name = ?, last_seen_at = ?, active = 1 WHERE id = ?",
        )
        .run(name, timestamp, student.id);
    } else {
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO students (id, class_id, name, device_id, joined_at, last_seen_at, active) VALUES (?, ?, ?, ?, ?, ?, 1)",
        )
        .run(id, classRow.id, name, deviceId, timestamp, timestamp);
      student = { id, class_id: classRow.id };
    }
    this.touchStudentSession(student.id, "connecting", timestamp);
    const current = this.db
      .prepare("SELECT * FROM students WHERE id = ?")
      .get(student.id);
    return { student: mapStudent(current), class: mapClass(classRow) };
  }

  getStudent(studentId) {
    return (
      this.db.prepare("SELECT * FROM students WHERE id = ?").get(studentId) ||
      null
    );
  }

  getStudentWithClass(studentId) {
    return (
      this.db
        .prepare(
          `SELECT s.*, c.name AS class_name, c.class_code, c.enabled, c.focus_goal,
      c.similarity_threshold, c.search_guard_enabled, c.policy_version, c.updated_at AS policy_updated_at, c.teacher_id
      FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`,
        )
        .get(studentId) || null
    );
  }

  touchStudent(studentId) {
    const timestamp = now();
    this.db
      .prepare("UPDATE students SET last_seen_at = ?, active = 1 WHERE id = ?")
      .run(timestamp, studentId);
    this.touchStudentSession(studentId, null, timestamp);
  }

  touchStudentSession(studentId, status = null, timestamp = now()) {
    const student = this.getStudent(studentId);
    if (!student) return null;
    const focusSession = this.getActiveFocusSession(student.class_id);
    if (!focusSession) return null;
    const current = this.db
      .prepare(
        "SELECT * FROM student_session_status WHERE session_id = ? AND student_id = ?",
      )
      .get(focusSession.id, studentId);
    const nextStatus = STUDENT_STATUSES.has(status)
      ? status
      : current?.status || "connecting";
    this.db
      .prepare(
        `INSERT INTO student_session_status (session_id, student_id, status, last_seen_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(session_id, student_id) DO UPDATE SET
      status = excluded.status, last_seen_at = excluded.last_seen_at`,
      )
      .run(focusSession.id, studentId, nextStatus, timestamp);
    if (status === "blocked")
      this.db
        .prepare(
          "UPDATE focus_sessions SET total_block_events = total_block_events + 1 WHERE id = ?",
        )
        .run(focusSession.id);
    this.updateMaxConnected(focusSession.id);
    return {
      sessionId: focusSession.id,
      status: nextStatus,
      updatedAt: timestamp,
    };
  }

  updateMaxConnected(sessionId) {
    const cutoff = new Date(Date.now() - CONNECTED_WINDOW_MS).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM student_session_status ss
      JOIN students s ON s.id = ss.student_id WHERE ss.session_id = ? AND s.active = 1 AND ss.last_seen_at >= ?`,
      )
      .get(sessionId, cutoff);
    this.db
      .prepare(
        "UPDATE focus_sessions SET max_connected = MAX(max_connected, ?) WHERE id = ?",
      )
      .run(Number(row?.count || 0), sessionId);
  }

  recordStudentStatus(studentId, status) {
    if (!STUDENT_STATUSES.has(status) || status === "connecting") return null;
    const timestamp = now();
    this.db
      .prepare("UPDATE students SET last_seen_at = ?, active = 1 WHERE id = ?")
      .run(timestamp, studentId);
    return this.touchStudentSession(studentId, status, timestamp);
  }

  leaveStudent(studentId) {
    this.db
      .prepare("UPDATE students SET active = 0, last_seen_at = ? WHERE id = ?")
      .run(now(), studentId);
    this.db.prepare("DELETE FROM sessions WHERE student_id = ?").run(studentId);
    this.db
      .prepare("DELETE FROM student_session_status WHERE student_id = ?")
      .run(studentId);
  }

  policyForStudent(studentId) {
    const row = this.getStudentWithClass(studentId);
    if (!row) return null;
    this.touchStudent(studentId);
    return {
      student: mapStudent(row),
      class: {
        id: row.class_id,
        name: row.class_name,
        classCode: row.class_code,
        policy: mapPolicy(row),
        updatedAt: row.policy_updated_at,
      },
    };
  }

  overview(teacherId, classId) {
    this.purgeExpiredData();
    const classRow = this.db
      .prepare("SELECT * FROM classes WHERE id = ? AND teacher_id = ?")
      .get(classId, teacherId);
    if (!classRow) return null;
    const focusSession =
      this.getActiveFocusSession(classId) ||
      this.getLatestFocusSession(classId);
    const statusRows = focusSession?.active
      ? this.db
          .prepare(
            `SELECT s.id, s.name, s.joined_at, s.last_seen_at, s.active,
      ss.status, ss.last_seen_at AS status_seen_at
      FROM students s LEFT JOIN student_session_status ss ON ss.student_id = s.id AND ss.session_id = ?
      WHERE s.class_id = ? ORDER BY s.active DESC, s.name COLLATE NOCASE`,
          )
          .all(focusSession.id, classId)
      : this.db
          .prepare(
            "SELECT id, name, joined_at, last_seen_at, active FROM students WHERE class_id = ? ORDER BY active DESC, name COLLATE NOCASE",
          )
          .all(classId);
    const cutoff = Date.now() - CONNECTED_WINDOW_MS;
    const students = statusRows.map((row) => {
      let status = "session ended";
      if (focusSession?.active) {
        const recentlySeen =
          Boolean(row.active) &&
          Date.parse(row.status_seen_at || row.last_seen_at) >= cutoff;
        status = recentlySeen ? row.status || "connecting" : "disconnected";
      }
      return {
        id: row.id,
        name: row.name,
        joinedAt: row.joined_at,
        lastSeenAt: row.status_seen_at || row.last_seen_at,
        status,
      };
    });
    const count = (status) =>
      students.filter((student) => student.status === status).length;
    const focused = count("focused");
    const blocked = count("blocked");
    const connecting = count("connecting");
    const disconnected = count("disconnected");
    const focusPercentage =
      focused + blocked
        ? Math.round((focused / (focused + blocked)) * 1000) / 10
        : focusSession?.final_focus_percentage;
    return {
      class: mapClass(classRow),
      students,
      totals: {
        connected: focused + blocked + connecting,
        focused,
        blocked,
        connecting,
        disconnected,
        blockedAttempts: Number(focusSession?.total_block_events || 0),
        focusPercentage: focusPercentage ?? null,
      },
      session: focusSession
        ? {
            id: focusSession.id,
            active: Boolean(focusSession.active),
            startedAt: focusSession.started_at,
            endedAt: focusSession.ended_at || null,
            durationSeconds: Math.max(
              0,
              Math.round(
                ((focusSession.ended_at
                  ? Date.parse(focusSession.ended_at)
                  : Date.now()) -
                  Date.parse(focusSession.started_at)) /
                  1000,
              ),
            ),
            totalBlockEvents: Number(focusSession.total_block_events || 0),
            focusPercentage: focusPercentage ?? null,
            maxConnected: Number(focusSession.max_connected || 0),
          }
        : null,
    };
  }

  generateClassCode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const bytes = randomBytes(6);
      const code = [...bytes]
        .map((byte) => CLASS_CODE_ALPHABET[byte % CLASS_CODE_ALPHABET.length])
        .join("");
      if (
        !this.db.prepare("SELECT 1 FROM classes WHERE class_code = ?").get(code)
      )
        return code;
    }
    throw new Error("Could not generate a unique class code");
  }
}

export function mapUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.created_at,
  };
}

export function mapPolicy(row) {
  return {
    enabled: Boolean(row.enabled),
    focusGoal: row.focus_goal || "",
    similarityThreshold:
      Number(row.similarity_threshold) || DEFAULT_SIMILARITY_THRESHOLD,
    searchGuardEnabled: Boolean(row.search_guard_enabled),
    version: Number(row.policy_version) || 1,
    updatedAt: row.policy_updated_at || row.updated_at || "",
  };
}

export function mapClass(row) {
  return {
    id: row.id,
    name: row.name,
    classCode: row.class_code,
    policy: mapPolicy(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapStudent(row) {
  return {
    id: row.id,
    classId: row.class_id,
    name: row.name,
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
    active: Boolean(row.active),
  };
}

function now() {
  return new Date().toISOString();
}
function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}
function hashPassword(password, salt) {
  return scryptSync(String(password), salt, 64).toString("hex");
}
function verifyPassword(password, salt, expected) {
  try {
    const actual = Buffer.from(hashPassword(password, salt), "hex");
    const target = Buffer.from(expected, "hex");
    return actual.length === target.length && timingSafeEqual(actual, target);
  } catch {
    return false;
  }
}
