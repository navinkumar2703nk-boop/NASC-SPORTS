const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || "NASCPD";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";

const db = new Database(path.join(__dirname, "nasc-sports.db"));
db.pragma("journal_mode = WAL");

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

const count = db.prepare("SELECT COUNT(*) AS c FROM events").get().c;
if (!count) {
  const insert = db.prepare(`
    INSERT INTO events (title,type,description,date,time,venue,registration_enabled)
    VALUES (?,?,?,?,?,?,?)
  `);
  insert.run(
    "Inter-Department Sports Selection Trials",
    "Selection Trial",
    "Selection trials for students interested in representing the college.",
    "2026-09-20",
    "10:00 AM",
    "College Sports Ground",
    1
  );
  insert.run(
    "NASC Football Friendly Match",
    "Match",
    "Friendly fixture conducted by the Physical Education Department.",
    "2026-09-25",
    "3:30 PM",
    "College Football Ground",
    0
  );
}

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 8 }
}));
app.use(express.static(path.join(__dirname, "public")));

function staffOnly(req, res, next) {
  if (!req.session.staff) return res.status(401).json({ error: "Staff login required." });
  next();
}

app.post("/api/login", (req, res) => {
  if (req.body.password === STAFF_PASSWORD) {
    req.session.staff = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Incorrect password." });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/session", (req, res) => {
  res.json({ staff: !!req.session.staff });
});

app.get("/api/events", (req, res) => {
  const events = db.prepare(`
    SELECT id,title,type,description,date,time,venue,registration_enabled
    FROM events ORDER BY date ASC, id DESC
  `).all();
  res.json(events);
});

app.post("/api/events", staffOnly, (req, res) => {
  const { title, type, description, date, time, venue, registration_enabled } = req.body;
  if (!title || !date) return res.status(400).json({ error: "Title and date are required." });
  const info = db.prepare(`
    INSERT INTO events (title,type,description,date,time,venue,registration_enabled)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    title.trim(), type || "Event", description || "", date, time || "", venue || "",
    registration_enabled ? 1 : 0
  );
  res.json({ id: info.lastInsertRowid });
});

app.put("/api/events/:id", staffOnly, (req, res) => {
  const { title, type, description, date, time, venue, registration_enabled } = req.body;
  if (!title || !date) return res.status(400).json({ error: "Title and date are required." });
  db.prepare(`
    UPDATE events
    SET title=?,type=?,description=?,date=?,time=?,venue=?,registration_enabled=?
    WHERE id=?
  `).run(
    title.trim(), type || "Event", description || "", date, time || "", venue || "",
    registration_enabled ? 1 : 0, req.params.id
  );
  res.json({ ok: true });
});

app.delete("/api/events/:id", staffOnly, (req, res) => {
  db.prepare("DELETE FROM events WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/events/:id/register", (req, res) => {
  const event = db.prepare("SELECT * FROM events WHERE id=?").get(req.params.id);
  if (!event) return res.status(404).json({ error: "Event not found." });
  if (!event.registration_enabled) return res.status(400).json({ error: "Registration is currently closed." });

  const { name, department, year, roll_no, phone } = req.body;
  if (!name || !department || !year || !roll_no)
    return res.status(400).json({ error: "Please fill all required fields." });

  try {
    db.prepare(`
      INSERT INTO registrations (event_id,name,department,year,roll_no,phone)
      VALUES (?,?,?,?,?,?)
    `).run(event.id, name.trim(), department.trim(), year.trim(), roll_no.trim(), (phone || "").trim());
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: "This roll number is already registered for this event." });
  }
});

app.get("/api/registrations", staffOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.name, r.department, r.year, r.roll_no, r.phone, r.created_at,
           e.title AS event_title, e.date AS event_date
    FROM registrations r
    JOIN events e ON e.id = r.event_id
    ORDER BY e.date ASC, r.created_at DESC
  `).all();
  res.json(rows);
});

app.delete("/api/registrations/:id", staffOnly, (req, res) => {
  db.prepare("DELETE FROM registrations WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/feedback", (req, res) => {
  const { kind, message } = req.body;
  if (!message || message.trim().length < 3)
    return res.status(400).json({ error: "Please enter a message." });
  db.prepare("INSERT INTO feedback (kind,message) VALUES (?,?)")
    .run(kind === "complaint" ? "complaint" : "enquiry", message.trim());
  res.json({ ok: true });
});

app.get("/api/feedback", staffOnly, (req, res) => {
  res.json(db.prepare("SELECT * FROM feedback ORDER BY created_at DESC").all());
});

app.delete("/api/feedback/:id", staffOnly, (req, res) => {
  db.prepare("DELETE FROM feedback WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`NASC Sports running at http://0.0.0.0:${PORT}`);
});