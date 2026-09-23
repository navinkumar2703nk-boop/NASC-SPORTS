const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

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
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_name TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  year TEXT DEFAULT '',
  roll_no TEXT DEFAULT '',
  sport TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  competition TEXT DEFAULT '',
  level TEXT NOT NULL DEFAULT 'Other',
  position TEXT DEFAULT '',
  achievement_year TEXT DEFAULT '',
  photo TEXT NOT NULL,
  achievement_photo TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'Other',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

// ---------------------------------------------------------------------------
// Idempotent migration for EXISTING DB files: adds the OPTIONAL second image
// ("Achievement Photo") column without touching achievement rows already
// stored. New databases get the column straight from the decorated CREATE
// TABLE above (see achievement_photo), so this only fires for pre-existing
// nasc-sports.db files — and fires at most once thanks to the name check.
// ---------------------------------------------------------------------------
const ACH_COLS = new Set(
  db.prepare("PRAGMA table_info(achievements)").all().map((c) => c.name)
);
if (!ACH_COLS.has("achievement_photo")) {
  db.exec("ALTER TABLE achievements ADD COLUMN achievement_photo TEXT DEFAULT ''");
}

// ---------------------------------------------------------------------------
// Settings + staff password (scrypt-hashed, never plaintext).
// The initial STAFF_PASSWORD is hashed only once, on first boot. Every later
// change persists in the settings table and is required for future logins.
// ---------------------------------------------------------------------------
function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(key, String(value));
}
function isMaintenance() {
  return getSetting("maintenance_enabled", "0") === "1";
}

function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return salt + ":" + hash;
}
function verifyPassword(pw, stored) {
  if (!stored || !/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(stored)) return false;
  const parts = stored.split(":");
  const test = crypto.scryptSync(String(pw), parts[0], 64).toString("hex");
  const a = Buffer.from(parts[1], "hex");
  const b = Buffer.from(test, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function getStaffHash() {
  return getSetting("staff_password_hash", "");
}
if (!getStaffHash()) {
  // First boot: store the initial password hash so future logins verify against it.
  setSetting("staff_password_hash", hashPassword(STAFF_PASSWORD));
}

// Self-contained maintenance page (no external assets so it survives the
// static middleware being bypassed). {{MESSAGE}} is injected at request time.
const MAINTENANCE_PAGE = fs.readFileSync(path.join(PUBLIC_DIR, "maintenance.html"), "utf8");

function escHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

// One-time cleanup of the legacy demo events that must not exist in the app.
// Guarded by a settings marker so this runs exactly once: a legitimate event
// later created as "TENNIS"/"ARM WRESTLING" is never silently deleted on boot.
if (getSetting("cleanup_legacy_events_done", "0") !== "1") {
  db.prepare("DELETE FROM events WHERE LOWER(title) IN (LOWER(?), LOWER(?))").run("ARM WRESTLING", "TENNIS");
  setSetting("cleanup_legacy_events_done", "1");
}

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

app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Maintenance mode guards
// ---------------------------------------------------------------------------
// Blocks public/student API usage while maintenance is on. Staff endpoints are
// unaffected (they require an authenticated session anyway).
function requirePublicUp(req, res, next) {
  if (isMaintenance()) {
    return res.status(503).json({ error: "We're currently updating the sports portal. Please check back soon." });
  }
  next();
}

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

// While maintenance is on, public visitors get the maintenance screen instead of
// the normal site. The staff portal (login + dashboard + their assets) stays up.
app.use((req, res, next) => {
  if (!isMaintenance() || req.method !== "GET") return next();
  if (req.path.startsWith("/api/")) return next();
  if (req.path.startsWith("/staff-login") || req.path.startsWith("/staff-dashboard")) return next();
  const ext = path.extname(req.path).toLowerCase();
  // Shared assets the staff portal needs must keep loading.
  if ([".css", ".js", ".json", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".woff2"].includes(ext)) {
    return next();
  }
  return res
    .status(503)
    .send(MAINTENANCE_PAGE.replace("{{MESSAGE}}", escHtml(getSetting("maintenance_message", ""))));
});

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
  if (verifyPassword(password, getStaffHash())) {
    req.session.staff = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Incorrect password." });
});

// Change the staff password. Confirmation is validated on the client; the
// backend enforces strength and requires the current password. The new hash is
// stored in the database and is required for all future logins.
app.post("/api/change-password", staffOnly, (req, res) => {
  const current = String((req.body && req.body.current_password) || "");
  const next = String((req.body && req.body.new_password) || "");
  if (!current) return res.status(400).json({ error: "Enter your current password." });
  if (!verifyPassword(current, getStaffHash())) {
    return res.status(400).json({ error: "Current password is incorrect." });
  }
  if (next.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters long." });
  }
  if (next === current) {
    return res.status(400).json({ error: "New password must be different from the current password." });
  }
  setSetting("staff_password_hash", hashPassword(next));
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/session", (req, res) => {
  res.json({ staff: !!(req.session && req.session.staff) });
});

// ---------------------------------------------------------------------------
// Maintenance mode (readable publicly, toggleable only by staff)
// ---------------------------------------------------------------------------
app.get("/api/maintenance", (req, res) => {
  res.json({
    enabled: isMaintenance(),
    message: getSetting("maintenance_message", ""),
  });
});

app.post("/api/maintenance", staffOnly, (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  const message = String((req.body && req.body.message) || "").trim().slice(0, 500);
  setSetting("maintenance_enabled", enabled ? "1" : "0");
  setSetting("maintenance_message", message);
  res.json({ ok: true, enabled, message });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
const EVENT_TYPES = ["Event", "Match", "Selection Trial", "Programme", "Tournament"];
function cleanType(t) {
  return EVENT_TYPES.includes(t) ? t : "Event";
}

app.get("/api/events", requirePublicUp, (req, res) => {
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
      cleanType(String(type || "Event")),
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
    cleanType(String(type || "Event")),
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
app.post("/api/events/:id/register", requirePublicUp, (req, res) => {
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
  // Mobile number is compulsory: exactly 10 digits, numbers only (no +91, no
  // spaces, no hyphens, no letters, no special characters).
  const phoneDigits = String(phone || "").trim();
  if (!/^\d{10}$/.test(phoneDigits)) {
    return res.status(400).json({ error: "Please enter a valid 10-digit mobile number." });
  }

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
      phoneDigits
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
app.post("/api/feedback", requirePublicUp, (req, res) => {
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
// Sports catalog
//
// Internationally recognised sports & disciplines (Olympic, Paralympic and
// widely internationally governed non-Olympic sports). No single "World Sports
// Federation" exists, so the taxonomy is intentionally plural: sports are
// grouped into broad categories agreed by name only. Achievements store the
// sport NAME as text, so historical records keep displaying correctly even if
// a sport is later disabled or renamed in this catalog.
// ---------------------------------------------------------------------------
const SPORTS_CATALOG = [
  // Athletics & Running
  ["Athletics & Running", "Athletics"],
  ["Athletics & Running", "Track and Field"],
  ["Athletics & Running", "Road Running"],
  ["Athletics & Running", "Cross Country"],
  ["Athletics & Running", "Race Walking"],
  ["Athletics & Running", "Marathon"],
  ["Athletics & Running", "Trail Running"],
  ["Athletics & Running", "Ultra Running"],
  ["Athletics & Running", "Mountain Running"],

  // Aquatic sports
  ["Aquatic Sports", "Swimming"],
  ["Aquatic Sports", "Diving"],
  ["Aquatic Sports", "Artistic Swimming"],
  ["Aquatic Sports", "Water Polo"],
  ["Aquatic Sports", "Open Water Swimming"],
  ["Aquatic Sports", "High Diving"],

  // Team sports
  ["Team Sports", "Football"],
  ["Team Sports", "Futsal"],
  ["Team Sports", "Beach Soccer"],
  ["Team Sports", "Basketball"],
  ["Team Sports", "3x3 Basketball"],
  ["Team Sports", "Volleyball"],
  ["Team Sports", "Beach Volleyball"],
  ["Team Sports", "Handball"],
  ["Team Sports", "Beach Handball"],
  ["Team Sports", "Rugby"],
  ["Team Sports", "Rugby Sevens"],
  ["Team Sports", "Cricket"],
  ["Team Sports", "Baseball"],
  ["Team Sports", "Softball"],
  ["Team Sports", "Hockey"],
  ["Team Sports", "Field Hockey"],
  ["Team Sports", "Lacrosse"],
  ["Team Sports", "American Football"],
  ["Team Sports", "Australian Football"],
  ["Team Sports", "Netball"],
  ["Team Sports", "Kabaddi"],
  ["Team Sports", "Kho Kho"],
  ["Team Sports", "Korfball"],
  ["Team Sports", "Ultimate"],
  ["Team Sports", "Dodgeball"],
  ["Team Sports", "Floorball"],
  ["Team Sports", "Bandy"],
  ["Team Sports", "Sepak Takraw"],

  // Racket sports
  ["Racket Sports", "Tennis"],
  ["Racket Sports", "Table Tennis"],
  ["Racket Sports", "Badminton"],
  ["Racket Sports", "Squash"],
  ["Racket Sports", "Padel"],
  ["Racket Sports", "Racquetball"],
  ["Racket Sports", "Pickleball"],
  ["Racket Sports", "Real Tennis"],

  // Combat sports
  ["Combat Sports", "Boxing"],
  ["Combat Sports", "Wrestling"],
  ["Combat Sports", "Freestyle Wrestling"],
  ["Combat Sports", "Greco-Roman Wrestling"],
  ["Combat Sports", "Judo"],
  ["Combat Sports", "Karate"],
  ["Combat Sports", "Taekwondo"],
  ["Combat Sports", "Muay Thai"],
  ["Combat Sports", "Kickboxing"],
  ["Combat Sports", "Sambo"],
  ["Combat Sports", "Sumo"],
  ["Combat Sports", "Brazilian Jiu-Jitsu"],
  ["Combat Sports", "Wushu"],
  ["Combat Sports", "Aikido"],
  ["Combat Sports", "Savate"],
  ["Combat Sports", "Fencing"],

  // Strength sports
  ["Strength Sports", "Weightlifting"],
  ["Strength Sports", "Powerlifting"],
  ["Strength Sports", "Bodybuilding"],
  ["Strength Sports", "Strongman"],
  ["Strength Sports", "Arm Wrestling"],

  // Cycling
  ["Cycling", "Road Cycling"],
  ["Cycling", "Track Cycling"],
  ["Cycling", "Mountain Biking"],
  ["Cycling", "BMX Racing"],
  ["Cycling", "BMX Freestyle"],
  ["Cycling", "Cyclocross"],
  ["Cycling", "Gravel Cycling"],

  // Gymnastics
  ["Gymnastics", "Artistic Gymnastics"],
  ["Gymnastics", "Rhythmic Gymnastics"],
  ["Gymnastics", "Trampoline Gymnastics"],
  ["Gymnastics", "Aerobic Gymnastics"],
  ["Gymnastics", "Acrobatic Gymnastics"],
  ["Gymnastics", "Parkour"],

  // Shooting
  ["Shooting", "Sport Shooting"],
  ["Shooting", "Rifle Shooting"],
  ["Shooting", "Pistol Shooting"],
  ["Shooting", "Shotgun Shooting"],
  ["Shooting", "Trap"],
  ["Shooting", "Skeet"],

  // Archery
  ["Archery", "Archery"],
  ["Archery", "Recurve Archery"],
  ["Archery", "Compound Archery"],
  ["Archery", "Field Archery"],

  // Equestrian
  ["Equestrian", "Dressage"],
  ["Equestrian", "Show Jumping"],
  ["Equestrian", "Eventing"],
  ["Equestrian", "Endurance Riding"],
  ["Equestrian", "Vaulting"],
  ["Equestrian", "Polo"],

  // Winter sports
  ["Winter Sports", "Alpine Skiing"],
  ["Winter Sports", "Cross-Country Skiing"],
  ["Winter Sports", "Ski Jumping"],
  ["Winter Sports", "Freestyle Skiing"],
  ["Winter Sports", "Snowboarding"],
  ["Winter Sports", "Biathlon"],
  ["Winter Sports", "Bobsleigh"],
  ["Winter Sports", "Skeleton"],
  ["Winter Sports", "Luge"],
  ["Winter Sports", "Curling"],
  ["Winter Sports", "Speed Skating"],
  ["Winter Sports", "Short Track Speed Skating"],
  ["Winter Sports", "Figure Skating"],
  ["Winter Sports", "Ice Hockey"],

  // Motorsports
  ["Motorsports", "Formula Racing"],
  ["Motorsports", "Karting"],
  ["Motorsports", "Rally"],
  ["Motorsports", "Rallycross"],
  ["Motorsports", "Touring Car Racing"],
  ["Motorsports", "Endurance Racing"],
  ["Motorsports", "Motorcycle Racing"],
  ["Motorsports", "Motocross"],
  ["Motorsports", "Supercross"],
  ["Motorsports", "Speedway"],
  ["Motorsports", "Powerboat Racing"],

  // Mind sports
  ["Mind Sports", "Chess"],
  ["Mind Sports", "Bridge"],
  ["Mind Sports", "Draughts"],
  ["Mind Sports", "Go"],
  ["Mind Sports", "Xiangqi"],

  // Bowls & precision sports
  ["Precision Sports", "Bocce"],
  ["Precision Sports", "Petanque"],
  ["Precision Sports", "Boules"],
  ["Precision Sports", "Lawn Bowls"],
  ["Precision Sports", "Bowling"],
  ["Precision Sports", "Ten-Pin Bowling"],
  ["Precision Sports", "Nine-Pin Bowling"],
  ["Precision Sports", "Billiards"],
  ["Precision Sports", "Pool"],
  ["Precision Sports", "Snooker"],
  ["Precision Sports", "Carom"],

  // Skating / boards
  ["Skating & Boards", "Roller Speed Skating"],
  ["Skating & Boards", "Artistic Roller Skating"],
  ["Skating & Boards", "Inline Hockey"],
  ["Skating & Boards", "Roller Hockey"],
  ["Skating & Boards", "Skateboarding"],

  // Climbing & mountain sports
  ["Climbing & Mountain Sports", "Sport Climbing"],
  ["Climbing & Mountain Sports", "Lead Climbing"],
  ["Climbing & Mountain Sports", "Bouldering"],
  ["Climbing & Mountain Sports", "Speed Climbing"],
  ["Climbing & Mountain Sports", "Mountaineering"],
  ["Climbing & Mountain Sports", "Ice Climbing"],
  ["Climbing & Mountain Sports", "Skyrunning"],

  // Air sports
  ["Air Sports", "Paragliding"],
  ["Air Sports", "Hang Gliding"],
  ["Air Sports", "Skydiving"],
  ["Air Sports", "Aeromodelling"],
  ["Air Sports", "Drone Racing"],
  ["Air Sports", "Gliding"],
  ["Air Sports", "Aerobatics"],

  // Water & board sports
  ["Water & Board Sports", "Surfing"],
  ["Water & Board Sports", "Windsurfing"],
  ["Water & Board Sports", "Kitesurfing"],
  ["Water & Board Sports", "Sailing"],
  ["Water & Board Sports", "Rowing"],
  ["Water & Board Sports", "Canoeing"],
  ["Water & Board Sports", "Kayaking"],
  ["Water & Board Sports", "Rafting"],
  ["Water & Board Sports", "Water Skiing"],
  ["Water & Board Sports", "Wakeboarding"],

  // Dance & performance
  ["Dance & Performance", "DanceSport"],
  ["Dance & Performance", "Breaking"],
  ["Dance & Performance", "Sport Aerobics"],
  ["Dance & Performance", "Cheerleading"],
  ["Dance & Performance", "Artistic Dance"],

  // Other international sports
  ["Other", "Tug of War"],
  ["Other", "Modern Pentathlon"],
  ["Other", "Triathlon"],
  ["Other", "Duathlon"],
  ["Other", "Aquathlon"],
  ["Other", "Orienteering"],
  ["Other", "Life Saving Sport"],
  ["Other", "Fistball"],
  ["Other", "Underwater Sports"],
  ["Other", "Finswimming"],
  ["Other", "Sport Fishing"],
  ["Other", "Casting Sport"],
  ["Other", "Lifesaving"],
  ["Other", "Flying Disc"],
  ["Other", "Disc Golf"],
  ["Other", "Teqball"],
  ["Other", "Footvolley"],
  ["Other", "Bossaball"],
];

// Seed the catalog once. INSERT OR IGNORE + UNIQUE(name) keeps every boot
// idempotent: sports added via the staff UI are never overwritten, and existing
// achievements are untouched.
(function seedSports() {
  const ins = db.prepare(
    "INSERT OR IGNORE INTO sports (name, category, active, sort_order, is_system) VALUES (?,?,?,?,1)"
  );
  const tx = db.transaction((rows) => {
    for (const [cat, name] of rows) {
      ins.run(name, cat, 1, 0);
    }
  });
  tx(SPORTS_CATALOG);
})();

// ---------------------------------------------------------------------------
// Sports API
// ---------------------------------------------------------------------------
const SPORT_CATEGORY_ORDER = [
  "Athletics & Running",
  "Aquatic Sports",
  "Team Sports",
  "Racket Sports",
  "Combat Sports",
  "Strength Sports",
  "Cycling",
  "Gymnastics",
  "Shooting",
  "Archery",
  "Equestrian",
  "Winter Sports",
  "Motorsports",
  "Mind Sports",
  "Precision Sports",
  "Skating & Boards",
  "Climbing & Mountain Sports",
  "Air Sports",
  "Water & Board Sports",
  "Dance & Performance",
  "Other",
];

function sportCategoryRank(cat) {
  const i = SPORT_CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? SPORT_CATEGORY_ORDER.length : i;
}

function listSports(includeInactive) {
  const rows = db
    .prepare(
      `SELECT id, name, category, active, sort_order, is_system
       FROM sports
       ${includeInactive ? "" : "WHERE active = 1"}
       ORDER BY ${includeInactive ? "active DESC, " : ""}name ASC`
    )
    .all();
  rows.sort((a, b) => sportCategoryRank(a.category) - sportCategoryRank(b.category) || a.name.localeCompare(b.name));
  return rows;
}

// GET /api/sports
// Public: only active sports (used by the public filter + both sport pickers).
// Staff (authenticated session): full catalog so the management UI can show
// disabled entries; also includes usage counts per sport.
app.get("/api/sports", requirePublicUp, (req, res) => {
  const isStaff = !!(req.session && req.session.staff);
  let rows = listSports(isStaff ? true : false);

  if (isStaff) {
    const usage = db
      .prepare("SELECT sport, COUNT(*) AS n FROM achievements GROUP BY sport")
      .all()
      .reduce((m, r) => { m[r.sport] = r.n; return m; }, {});
    rows = rows.map((s) => ({ ...s, used: usage[s.name] || 0 }));
  } else {
    rows = rows.map(({ active, is_system, ...rest }) => rest);
  }
  res.json({ sports: rows });
});

// Staff: add a sport. No delete is offered anywhere — disable instead, so
// historical achievements keep displaying their original sport name.
app.post("/api/sports", staffOnly, (req, res) => {
  const name = String((req.body && req.body.name) || "").trim();
  const category = String((req.body && req.body.category) || "Other").trim();
  if (!name) return res.status(400).json({ error: "Sport name is required." });
  if (name.length > 80) return res.status(400).json({ error: "Sport name must be 80 characters or fewer." });
  const cleanCat = category.slice(0, 60);

  const dup = db.prepare("SELECT id FROM sports WHERE name = ?").get(name);
  if (dup) return res.status(409).json({ error: `"${name}" is already in the sports list.` });

  const info = db
    .prepare("INSERT INTO sports (name, category, active, sort_order) VALUES (?,?,1,0)")
    .run(name, cleanCat);
  res.json({ id: info.lastInsertRowid });
});

// Staff: edit a sport. Renaming updates the catalog entry AND any achievements
// that used the old name, so historical records follow the rename cleanly.
// Disabling a sport only hides it from new pickers/filters; stored achievements
// keep their sport text and continue to display.
app.put("/api/sports/:id", staffOnly, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM sports WHERE id=?").get(id);
  if (!existing) return res.status(404).json({ error: "Sport not found." });

  const b = req.body || {};
  let name = existing.name;
  if (typeof b.name === "string") {
    name = b.name.trim();
    if (!name) return res.status(400).json({ error: "Sport name is required." });
    if (name.length > 80) return res.status(400).json({ error: "Sport name must be 80 characters or fewer." });
    const dup = db.prepare("SELECT id FROM sports WHERE name = ? AND id != ?").get(name, id);
    if (dup) return res.status(409).json({ error: `"${name}" is already used by another sport.` });
  }
  const category = typeof b.category === "string" && b.category.trim() ? b.category.trim().slice(0, 60) : existing.category;
  const active = typeof b.active === "boolean" ? (b.active ? 1 : 0) : existing.active;

  db.prepare("UPDATE sports SET name=?, category=?, active=? WHERE id=?").run(name, category, active, id);

  // Cascade rename to historical achievements so records follow the new name.
  if (name !== existing.name) {
    db.prepare("UPDATE achievements SET sport=? WHERE sport=?").run(name, existing.name);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Student Achievements
// ---------------------------------------------------------------------------
const ACHIEVEMENT_LEVELS = ["College", "Inter-College", "Zonal", "District", "State", "National", "International", "Other"];
const ACH_UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads", "achievements");
const MAX_ACH_PHOTO_BYTES = 3 * 1024 * 1024; // ~3 MB decoded upload ceiling

fs.mkdirSync(ACH_UPLOAD_DIR, { recursive: true });

function normalizedLevel(lvl) {
  return ACHIEVEMENT_LEVELS.includes(lvl) ? lvl : "Other";
}

// If a staff member enters a sport name that is not yet in the sports catalog
// (via "Other"), register it automatically so it appears in pickers and the
// public filter without any frontend change. Achievements keep the raw name.
function ensureSportRegistered(name) {
  if (!name) return;
  const row = db.prepare("SELECT id FROM sports WHERE name = ?").get(name);
  if (!row) {
    db.prepare("INSERT OR IGNORE INTO sports (name, category, active, sort_order) VALUES (?,?,1,0)").run(name, "Other");
  }
}

// Validates & stores a student photo from a base64 data-URL. Returns the
// public path ("/uploads/achievements/<file>") or null when the payload is
// empty. A null ALSO means "no change" for updates (existing photo kept).
function storePhoto(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl) return null;
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!m) return { error: "Unsupported image format." };
  const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
  const data = Buffer.from(m[2], "base64");
  if (!data.length) return { error: "Student photo is required." };
  if (data.length > MAX_ACH_PHOTO_BYTES) {
    return { error: "Student photo is too large. Please upload a smaller photo (max 3 MB)." };
  }
  const file = `ach_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(ACH_UPLOAD_DIR, file), data);
  return { path: `/uploads/achievements/${file}` };
}

function removePhotoFile(photoPath) {
  if (typeof photoPath !== "string" || !photoPath.startsWith("/uploads/achievements/")) return;
  try {
    fs.unlinkSync(path.join(PUBLIC_DIR, photoPath));
  } catch {
    // Best effort cleanup; a missing file is not a failure.
  }
}

// ---------------------------------------------------------------------------
// Optional 2nd image: "Achievement Photo" (medal/trophy/receiving-shot).
// Shares the exact format validation, 3 MB ceiling and upload folder as the
// required student photo, but an EMPTY payload means "none / keep existing"
// (returns null — NOT an error) so the field is genuinely optional both when
// creating and when editing.
// ---------------------------------------------------------------------------
function storeAchievementPhoto(dataUrl) {
  return storePhoto(dataUrl.toString());
}
function removeAchievementPhotoFile(photoPath) {
  removePhotoFile(photoPath);
}

app.get("/api/achievements", requirePublicUp, (req, res) => {
  const rows = db.prepare("SELECT * FROM achievements ORDER BY created_at DESC, id DESC").all();
  res.json(rows);
});

app.get("/api/achievements/:id", requirePublicUp, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT * FROM achievements WHERE id=?").get(id);
  if (!row) return res.status(404).json({ error: "Achievement not found." });
  res.json(row);
});

app.post("/api/achievements", staffOnly, (req, res) => {
  const b = req.body || {};
  const name = String(b.student_name || "").trim();
  const sport = String(b.sport || "").trim();
  const title = String(b.title || "").trim();
  if (!name) return res.status(400).json({ error: "Student name is required." });
  if (!sport) return res.status(400).json({ error: "Sport is required." });
  if (!title) return res.status(400).json({ error: "Achievement title is required." });
  ensureSportRegistered(sport);

  // Student photo is OPTIONAL. Empty payload -> no file stored -> empty string.
  let photoPathValue = "";
  if (b.photo_data || b.photo) {
    const photo = storePhoto(b.photo_data || b.photo);
    if (!photo || photo.error) return res.status(400).json({ error: (photo && photo.error) || "Unable to upload the student photo." });
    photoPathValue = photo.path;
  }

  // Optional 2nd image. Empty payload -> nothing stored.
  let achPath = "";
  if (typeof b.achievement_photo_data === "string" && b.achievement_photo_data) {
    const storedAch = storeAchievementPhoto(b.achievement_photo_data);
    if (!storedAch || storedAch.error) {
      return res.status(400).json({ error: (storedAch && storedAch.error) || "Unable to upload the achievement photo." });
    }
    achPath = storedAch.path;
  }

  const info = db
    .prepare(`
      INSERT INTO achievements
        (student_name, department, year, roll_no, sport, title, description, competition, level, position, achievement_year, photo, achievement_photo)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)
    .run(
      name,
      String(b.department || "").trim(),
      String(b.year || "").trim(),
      String(b.roll_no || "").trim(),
      sport,
      title,
      String(b.description || "").trim(),
      String(b.competition || "").trim(),
      normalizedLevel(b.level),
      String(b.position || "").trim(),
      String(b.achievement_year || "").trim(),
      photoPathValue,
      achPath
    );
  res.json({ id: info.lastInsertRowid });
});

app.put("/api/achievements/:id", staffOnly, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM achievements WHERE id=?").get(id);
  if (!existing) return res.status(404).json({ error: "Achievement not found." });

  const b = req.body || {};
  const name = String(b.student_name || "").trim();
  const sport = String(b.sport || "").trim();
  const title = String(b.title || "").trim();
  if (!name) return res.status(400).json({ error: "Student name is required." });
  if (!sport) return res.status(400).json({ error: "Sport is required." });
  if (!title) return res.status(400).json({ error: "Achievement title is required." });
  ensureSportRegistered(sport);

  // New photo only when one was uploaded; otherwise the existing one is kept.
  let newPath = null;
  if (b.photo_data) {
    const stored = storePhoto(b.photo_data);
    if (!stored || stored.error) return res.status(400).json({ error: (stored && stored.error) || "Unable to upload the photo." });
    newPath = stored.path;
  }

  // Optional 2nd image on EDIT: keep existing when nothing was uploaded,
  // REPLACE when new data arrives (old file cleaned up), and REMOVE when the
  // client sends remove_achievement_photo (file + path both cleared).
  let achNewPath = null;
  let achEmpty = false;
  if (b.achievement_photo_data) {
    const storedAch = storeAchievementPhoto(b.achievement_photo_data);
    if (!storedAch || storedAch.error) return res.status(400).json({ error: (storedAch && storedAch.error) || "Unable to upload the achievement photo." });
    achNewPath = storedAch.path;
  } else if (b.remove_achievement_photo === true || b.remove_achievement_photo === "1" || b.remove_achievement_photo === 1) {
    achEmpty = true;
  }
  const achFinal = achNewPath ? achNewPath : achEmpty ? "" : (existing.achievement_photo || "");

  if (achNewPath && existing.achievement_photo) removeAchievementPhotoFile(existing.achievement_photo);
  if (achEmpty && existing.achievement_photo) removeAchievementPhotoFile(existing.achievement_photo);
  let achRemoveDone = false;

  db.prepare(`
    UPDATE achievements
    SET student_name=?, department=?, year=?, roll_no=?, sport=?, title=?, description=?,
        competition=?, level=?, position=?, achievement_year=?, photo=?, achievement_photo=?
    WHERE id=?
  `).run(
    name,
    String(b.department || "").trim(),
    String(b.year || "").trim(),
    String(b.roll_no || "").trim(),
    sport,
    title,
    String(b.description || "").trim(),
    String(b.competition || "").trim(),
    normalizedLevel(b.level),
    String(b.position || "").trim(),
    String(b.achievement_year || "").trim(),
    newPath || existing.photo,
    achFinal,
    id
  );

  if (newPath) removePhotoFile(existing.photo);
  res.json({ ok: true });
});

app.delete("/api/achievements/:id", staffOnly, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT photo FROM achievements WHERE id=?").get(id);
  if (!existing) return res.status(404).json({ error: "Achievement not found." });

  db.prepare("DELETE FROM achievements WHERE id=?").run(id);
  removePhotoFile(existing.photo);
  removeAchievementPhotoFile(existing.achievement_photo);
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