const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || "NASCPD";
const SESSION_SECRET = process.env.SESSION_SECRET || "nasc-sports-session-secret-change-me";
// The staff session cookie must be cross-site + HTTPS-capable in production
// (Android WebView https://localhost -> Render API), so we use SameSite=None + Secure.
// During local http development (http://localhost) that combo would be rejected,
// so we fall back to SameSite=Lax there.
const IS_SECURE = process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true";
const PUBLIC_DIR = path.join(__dirname, "public");

// Render / production runs behind a proxy (https). Trust it so req.secure works
// and to satisfy express-session's secure cookie checks.
app.set("trust proxy", 1);

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new Database(path.join(__dirname, "nasc-sports.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Event',
  description TEXT DEFAULT '',
  date TEXT NOT NULL,
  time TEXT DEFAULT '',
  venue TEXT DEFAULT '',
  registration_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  department TEXT NOT NULL,
  year TEXT NOT NULL,
  roll_no TEXT NOT NULL,
  phone TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(event_id, roll_no),
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

// One-time cleanup of the legacy events that must not exist in the app.
// This runs safely on every boot and never recreates them.
db.prepare("DELETE FROM events WHERE LOWER(title) IN (LOWER(?), LOWER(?))").run("ARM WRESTLING", "TENNIS");

// ---------------------------------------------------------------------------
// CORS - credentials-friendly. Never use `*` when cookies are allowed.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
  "https://nasc-sports.onrender.com",
  "https://localhost",
  "cap://localhost",
  "capacitor://localhost",
  "http://localhost",
  "http://localhost:3000",
  "http://localhost:8080",
  "http://127.0.0.1",
  "http://127.0.0.1:3000",
];

function originAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Local dev experiment origins (localhost on any port).
  try {
    const u = new URL(origin);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
  }
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Accept,X-Requested-With");
  res.header("Vary", "Origin");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    // Cross-site + HTTPS friendly in production (Android WebView https://localhost -> Render API).
    cookie: {
      httpOnly: true,
      sameSite: IS_SECURE ? "none" : "lax",
      secure: IS_SECURE,
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function staffOnly(req, res, next) {
  if (!req.session || !req.session.staff) {
    return res.status(401).json({ error: "Staff login required." });
  }
  next();
}

app.post("/api/login", (req, res) => {
  const password = String(req.body.password || "");
  if (password === STAFF_PASSWORD) {
    req.session.staff = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Incorrect password." });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/session", (req, res) => {
  res.json({ staff: !!(req.session && req.session.staff) });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
app.get("/api/events", (req, res) => {
  const events = db
    .prepare(`
      SELECT id, title, type, description, date, time, venue, registration_enabled
      FROM events
      ORDER BY date ASC, id DESC
    `)
    .all();
  res.json(events);
});

app.post("/api/events", staffOnly, (req, res) => {
  const { title, type, description, date, time, venue, registration_enabled } = req.body;
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: "Event title is required." });
  }
  if (!date) return res.status(400).json({ error: "Event date is required." });
  const info = db
    .prepare(`
      INSERT INTO events (title, type, description, date, time, venue, registration_enabled)
      VALUES (?,?,?,?,?,?,?)
    `)
    .run(
      String(title).trim(),
      String(type || "Event"),
      String(description || "").trim(),
      String(date),
      String(time || "").trim(),
      String(venue || "").trim(),
      registration_enabled ? 1 : 0
    );
  res.json({ id: info.lastInsertRowid });
});

app.put("/api/events/:id", staffOnly, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT id FROM events WHERE id=?").get(id);
  if (!existing) return res.status(404).json({ error: "Event not found." });

  const { title, type, description, date, time, venue, registration_enabled } = req.body;
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: "Event title is required." });
  }
  if (!date) return res.status(400).json({ error: "Event date is required." });

  db.prepare(`
    UPDATE events
    SET title=?, type=?, description=?, date=?, time=?, venue=?, registration_enabled=?
    WHERE id=?
  `).run(
    String(title).trim(),
    String(type || "Event"),
    String(description || "").trim(),
    String(date),
    String(time || "").trim(),
    String(venue || "").trim(),
    registration_enabled ? 1 : 0,
    id
  );
  res.json({ ok: true });
});

app.delete("/api/events/:id", staffOnly, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT id FROM events WHERE id=?").get(id);
  if (!existing) return res.status(404).json({ error: "Event not found." });

  // Explicit delete (foreign_keys pragma also cascades as a safety net).
  db.prepare("DELETE FROM registrations WHERE event_id=?").run(id);
  db.prepare("DELETE FROM events WHERE id=?").run(id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------
app.post("/api/events/:id/register", (req, res) => {
  const id = Number(req.params.id);
  const event = db.prepare("SELECT id, registration_enabled, title FROM events WHERE id=?").get(id);
  if (!event) return res.status(404).json({ error: "Event not found." });
  if (!event.registration_enabled) {
    return res.status(400).json({ error: "Registration is currently closed for this event." });
  }

  const { name, department, year, roll_no, phone } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Full name is required." });
  if (!department || !String(department).trim()) return res.status(400).json({ error: "Department / course is required." });
  if (!year || !String(year).trim()) return res.status(400).json({ error: "Year / semester is required." });
  if (!roll_no || !String(roll_no).trim()) return res.status(400).json({ error: "Roll number is required." });

  try {
    db.prepare(`
      INSERT INTO registrations (event_id, name, department, year, roll_no, phone)
      VALUES (?,?,?,?,?,?)
    `).run(
      event.id,
      String(name).trim(),
      String(department).trim(),
      String(year).trim(),
      String(roll_no).trim(),
      String(phone || "").trim()
    );
    res.json({ ok: true });
  } catch (err) {
    if (String(err && err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "This roll number is already registered for this event." });
    }
    throw err;
  }
});

app.get("/api/registrations", staffOnly, (req, res) => {
  const rows = db
    .prepare(`
      SELECT r.id, r.event_id, r.name, r.department, r.year, r.roll_no, r.phone, r.created_at,
             e.title AS event_title, e.date AS event_date
      FROM registrations r
      JOIN events e ON e.id = r.event_id
      ORDER BY e.date ASC, r.created_at DESC
    `)
    .all();
  res.json(rows);
});

app.delete("/api/registrations/:id", staffOnly, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT id FROM registrations WHERE id=?").get(id);
  if (!existing) return res.status(404).json({ error: "Registration not found." });
  db.prepare("DELETE FROM registrations WHERE id=?").run(id);
  res.json({ ok: true });
});

// Toggle student registration OPEN/CLOSED for an event.
// Closing never deletes existing registrations - only flips registration_enabled.
app.post("/api/events/:id/registration", staffOnly, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT id FROM events WHERE id=?").get(id);
  if (!existing) return res.status(404).json({ error: "Event not found." });

  const enabled = req.body && req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : existing.registration_enabled;
  db.prepare("UPDATE events SET registration_enabled=? WHERE id=?").run(enabled, id);
  res.json({ ok: true, registration_enabled: enabled });
});

// ---------------------------------------------------------------------------
// Feedback (anonymous enquiries & complaints)
// ---------------------------------------------------------------------------
app.post("/api/feedback", (req, res) => {
  const kind = req.body.kind === "complaint" ? "complaint" : "enquiry";
  const message = String(req.body.message || "").trim();
  if (message.length < 3) return res.status(400).json({ error: "Please enter a message." });
  db.prepare("INSERT INTO feedback (kind, message) VALUES (?,?)").run(kind, message);
  res.json({ ok: true });
});

app.get("/api/feedback", staffOnly, (req, res) => {
  res.json(db.prepare("SELECT * FROM feedback ORDER BY created_at DESC").all());
});

app.delete("/api/feedback/:id", staffOnly, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT id FROM feedback WHERE id=?").get(id);
  if (!existing) return res.status(404).json({ error: "Message not found." });
  db.prepare("DELETE FROM feedback WHERE id=?").run(id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
app.get(["/staff-login", "/staff-login/"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "staff-login.html"));
});
app.get(["/staff-dashboard", "/staff-dashboard/"], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "staff-dashboard.html"));
});
app.get(["/404", "/404.html"], (req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
});
app.get(["/500", "/500.html"], (req, res) => {
  res.status(500).sendFile(path.join(PUBLIC_DIR, "500.html"));
});
app.get(["/503", "/503.html"], (req, res) => {
  res.status(503).sendFile(path.join(PUBLIC_DIR, "503.html"));
});

// Unknown API routes -> JSON 404
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found." });
});

// Unknown page routes -> HTML 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
});

// ---------------------------------------------------------------------------
// Error handling (no stack traces exposed)
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  const msg = String((err && err.message) || "");
  if (req.path.startsWith("/api")) {
    if (/SQLITE_BUSY|SQLITE_LOCKED/.test(msg)) {
      return res.status(503).json({ error: "Service temporarily unavailable. Please try again." });
    }
    console.error("API error:", err);
    return res.status(500).json({ error: "Server error. Please try again later." });
  }
  if (/SQLITE_BUSY|SQLITE_LOCKED/.test(msg)) {
    console.error("Service unavailable:", err);
    return res.status(503).sendFile(path.join(PUBLIC_DIR, "503.html"));
  }
  console.error("Server error:", err);
  res.status(500).sendFile(path.join(PUBLIC_DIR, "500.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`NASC Sports running at http://0.0.0.0:${PORT}`);
});