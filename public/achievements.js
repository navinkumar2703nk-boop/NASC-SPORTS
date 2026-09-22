const isNative = typeof window !== "undefined" && window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform();
const onLocalHost = typeof location !== "undefined" && /^(http|https):\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(location.origin);
const API_BASE = isNative || !onLocalHost ? "https://nasc-sports.onrender.com" : location.origin;

const $ = (s) => document.querySelector(s);
let achievements = [];
let active = { q: "", sport: "all", level: "all", year: "all", result: "all", sort: "newest" };

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function api(url, options = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${url}`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      ...options,
    });
  } catch {
    throw new ApiError("Unable to connect to NASC Sports server. Please check your internet connection and try again.");
  }

  let data = {};
  try { data = await res.json(); } catch {}

  if (!res.ok) {
    const fallback = {
      400: "Invalid request. Please check your details.",
      404: "Not found.",
      500: "Server Error. Please try again later.",
      503: "Service Unavailable. Please try again later.",
    };
    throw new ApiError(data.error || fallback[res.status] || "Something went wrong.", res.status, data);
  }
  return data;
}

function esc(v = "") {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

// Student photos are stored on the API host (uploaded by staff). The page must
// resolve them against API_BASE so they load in desktop, mobile and the native
// Capacitor app (where the page itself comes from the app bundle).
function photoUrl(p) {
  if (!p) return "";
  if (/^(https?:)?\/\//.test(p)) return p;
  return API_BASE + (p.charAt(0) === "/" ? p : "/" + p);
}

function populateOptions() {
  const sports = [...new Set(achievements.map((a) => (a.sport || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const years = [...new Set(achievements.map((a) => (a.achievement_year || "").trim()).filter(Boolean))].sort();
  const levels = ["College", "Inter-College", "Zonal", "District", "State", "National", "International", "Other"]
    .filter((l) => achievements.some((a) => a.level === l));

  $("#achSport").innerHTML = `<option value="all">All Sports</option>` + sports.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#achLevel").innerHTML = `<option value="all">All Levels</option>` + levels.map((l) => `<option>${esc(l)}</option>`).join("");
  $("#achYear").innerHTML = `<option value="all">All Years</option>` + years.map((y) => `<option>${esc(y)}</option>`).join("");
}

function filtered() {
  const q = active.q.toLowerCase().trim();
  let list = achievements.filter((a) => {
    if (active.sport !== "all" && a.sport !== active.sport) return false;
    if (active.level !== "all" && a.level !== active.level) return false;
    if (active.year !== "all" && a.achievement_year !== active.year) return false;
    if (active.result !== "all" && resultBucket(a.position) !== active.result) return false;
    if (q && ![a.student_name, a.sport, a.title, a.competition, a.position, a.level].join(" ").toLowerCase().includes(q)) return false;
    return true;
  });
  if (active.sort === "name") list = [...list].sort((a, b) => (a.student_name || "").localeCompare(b.student_name || ""));
  else if (active.sort === "sport") list = [...list].sort((a, b) => (a.sport || "").localeCompare(b.sport || ""));
  return list;
}

// Maps a stored position/result string to a medal/result bucket.
function resultBucket(p = "") {
  const s = String(p).toLowerCase();
  if (/gold|^1st|^first|champion/.test(s)) return "Gold";
  if (/silver|^2nd|^second/.test(s)) return "Silver";
  if (/bronze|^3rd|^third/.test(s)) return "Bronze";
  if (/winner/.test(s)) return "Winner";
  if (/runner|^2/.test(s)) return "Runner-Up";
  if (/selected|shortlist|member|team/.test(s)) return "Selected";
  if (/participation|participated|took part/.test(s)) return "Participation";
  if (s) return "Placement";
  return "";
}

// A photo block that renders a real <img> or a styled NASC fallback.
function photoBlock(photo, name, cls = "") {
  if (photo) return `<div class="ach-photo ${cls}"><img src="${esc(photoUrl(photo))}" alt="${esc(name)}" loading="lazy"></div>`;
  return `<div class="ach-photo ${cls}"><span class="ach-photo-fallback">NASC</span></div>`;
}

function cardMarkup(a) {
  const bucket = resultBucket(a.position);
  return `<article class="ach-card" data-id="${a.id}">
    <div class="ach-photo-wrap">${photoBlock(a.photo, a.student_name)}${a.achievement_photo ? `<span class="ach-ach-badge" title="Action shot">&#128247;</span>` : ""}</div>
    <div class="ach-card-body">
      <h3 class="ach-name">${esc(a.student_name)}</h3>
      <span class="ach-meta muted">${esc(a.department) || "Department"}${a.year ? ` · ${esc(a.year)}` : ""}</span>
      <p class="ach-tag tag">${esc(a.sport)}</p>
      <p class="ach-title"><span class="trophy">&#127942;</span> ${esc(a.title)}</p>
      ${a.position ? `<span class="badge badge-open ach-position">${esc(a.position)}</span>` : ""}
      <span class="ach-meta muted">${esc(a.level)}${a.achievement_year ? ` · ${esc(a.achievement_year)}` : ""}</span>
      <button class="button secondary small" type="button" data-detail="${a.id}">View Details</button>
    </div>
  </article>`;
}

function render() {
  populateOptions();
  const list = filtered();
  const grid = $("#achGrid");
  if (!achievements.length) {
    grid.innerHTML = `<div class="panel"><strong>No achievements yet.</strong><span class="muted">Student achievements will appear here once the department publishes them.</span></div>`;
  } else if (!list.length) {
    grid.innerHTML = `<div class="panel"><strong>No matching achievements.</strong><span class="muted">Try a different search term or filter.</span></div>`;
  } else {
    grid.innerHTML = list.map(cardMarkup).join("");
    grid.querySelectorAll("[data-detail]").forEach((btn) => {
      btn.addEventListener("click", () => openDetail(Number(btn.dataset.detail)));
    });
  }
  $("#achCount").textContent = list.length === achievements.length
    ? `${achievements.length} achievement${achievements.length === 1 ? "" : "s"}`
    : `${list.length} of ${achievements.length} achievements`;
}

// OUR ACHIEVERS — students ranked by podium finishes (gold=silver>browseronze>winner).
function renderBoard() {
  const board = $("#achBoard");
  if (!board) return;
  const counts = {};
  for (const a of achievements) {
    const key = (a.student_name || "").trim() || "—";
    counts[key] = counts[key] || { name: key, dept: a.department || "", photo: a.photo || "", gold: 0, silver: 0, bronze: 0, other: 0 };
    const b = resultBucket(a.position);
    if (b === "Gold") counts[key].gold++;
    else if (b === "Silver") counts[key].silver++;
    else if (b === "Bronze") counts[key].bronze++;
    else counts[key].other++;
  }
  const ranked = Object.values(counts).sort(
    (a, b) => (b.gold - a.gold) || (b.silver - a.silver) || (b.bronze - a.bronze) || ((b.gold + b.silver + b.bronze) - (a.gold + a.silver + a.bronze))
  ).slice(0, 10);
  if (!ranked.length) {
    board.innerHTML = `<p class="muted">No honourees yet — the roll of honour appears once achievements are published.</p>`;
    return;
  }
  const totalScores = ranked.map((r) => r.gold * 3 + r.silver * 2 + r.bronze);
  const maxScore = Math.max(...totalScores, 1);
  board.innerHTML = ranked.map((r, i) => {
    const score = r.gold * 3 + r.silver * 2 + r.bronze;
    return `<button type="button" class="ach-board-row" data-student="${esc(r.name)}">
      <span class="ach-rank">${i + 1}</span>
      ${photoBlock(r.photo, r.name, "ach-board-photo")}
      <span class="ach-board-main">
        <span class="ach-board-name">${esc(r.name)}</span>
        <span class="muted">${esc(r.dept) || "Student"} · ${r.gold + r.silver + r.bronze} podium finish${r.gold + r.silver + r.bronze === 1 ? "" : "es"}</span>
      </span>
      <span class="ach-board-medals">
        ${r.gold ? `<span class="ach-medal gold" title="Gold">&#127942; ${r.gold}</span>` : ""}
        ${r.silver ? `<span class="ach-medal silver" title="Silver">&#129354; ${r.silver}</span>` : ""}
        ${r.bronze ? `<span class="ach-medal bronze" title="Bronze">&#129353; ${r.bronze}</span>` : ""}
      </span>
      <span class="ach-board-bar"><span style="width:${Math.round((score / maxScore) * 100)}%"></span></span>
    </button>`;
  }).join("");
  board.querySelectorAll(".ach-board-row").forEach((row) => {
    row.addEventListener("click", () => {
      const name = row.dataset.student;
      $("#achSearch").value = name;
      $("#achSearch").dispatchEvent(new Event("input"));
      document.getElementById("achGrid").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function openDetail(id) {
  const a = achievements.find((x) => x.id === id);
  if (!a) return;
  const gallery = [a.photo, a.achievement_photo].filter(Boolean).map((p) => `<img class="ach-detail-photo" src="${esc(photoUrl(p))}" alt="${esc(a.student_name)}" loading="lazy">`).join("");
  const galleryBlock = gallery ? `<div class="ach-detail-gallery">${gallery}</div>` : "";
  const detail = [
    galleryBlock,
    `<p class="eyebrow">STUDENT ACHIEVEMENT</p>`,
    `<h2 class="ach-detail-name">${esc(a.student_name)}</h2>`,
    `<p class="muted">${esc(a.department) || "Department"}${a.year ? ` · ${esc(a.year)}` : ""}</p>`,
    `<div class="ev-details">`,
    `<div class="ev-detail"><span>Sport</span><strong>${esc(a.sport)}</strong></div>`,
    `<div class="ev-detail"><span>Achievement</span><strong>${esc(a.title)}</strong></div>`,
    `<div class="ev-detail"><span>Competition</span><strong>${esc(a.competition || "—")}</strong></div>`,
    `<div class="ev-detail"><span>Level</span><strong>${esc(a.level)}</strong></div>`,
    `<div class="ev-detail"><span>Position / Result</span><strong>${esc(a.position || "—")}</strong></div>`,
    `<div class="ev-detail"><span>Year</span><strong>${esc(a.achievement_year || "—")}</strong></div>`,
    a.roll_no ? `<div class="ev-detail"><span>Roll Number</span><strong>${esc(a.roll_no)}</strong></div>` : "",
    `</div>`,
    a.achievement_photo ? `<p class="ev-desc"><em>Includes an action / result photo above.</em></p>` : "",
    a.description ? `<p class="ev-desc">${esc(a.description)}</p>` : "",
  ].join("");
  $("#achDetailContent").innerHTML = detail;
  $("#achDetailModal").classList.remove("hidden");
}

function closeDetail() {
  $("#achDetailModal").classList.add("hidden");
}

// Maintenance check (same behaviour as the homepage).
async function ensurePublicUp() {
  try {
    const m = await api("/api/maintenance");
    if (m && m.enabled) {
      const ov = document.createElement("div");
      ov.className = "maint-overlay";
      ov.innerHTML = `<div class="maint-box">
        <span class="mark">N</span>
        <h1>NASC <small>SPORTS</small></h1>
        <h2>Under Maintenance</h2>
        <p>${esc(m.message || "We're currently updating the sports portal. Please check back soon.")}</p>
        <span class="pulse"></span>
      </div>`;
      document.body.appendChild(ov);
    }
  } catch {
    // Connectivity errors handled on the load itself.
  }
}

function bindUI() {
  $("#achSearch").addEventListener("input", (e) => { active.q = e.target.value; render(); });
  $("#achSport").addEventListener("change", (e) => { active.sport = e.target.value; render(); });
  $("#achLevel").addEventListener("change", (e) => { active.level = e.target.value; render(); });
  $("#achYear").addEventListener("change", (e) => { active.year = e.target.value; render(); });
  $("#achResult").addEventListener("change", (e) => { active.result = e.target.value; render(); });
  $("#achSort").addEventListener("change", (e) => { active.sort = e.target.value; render(); });
  $("#closeAchDetail").addEventListener("click", closeDetail);
  $("#achDetailCloseBtn").addEventListener("click", closeDetail);
  $("#achDetailModal").addEventListener("click", (e) => {
    if (e.target === $("#achDetailModal")) closeDetail();
  });
}

(async function init() {
  bindUI();
  await ensurePublicUp();
  try {
    achievements = await api("/api/achievements");
  } catch (err) {
    if (err.status && err.status === 503) return;
    $("#achGrid").innerHTML = `<div class="panel"><strong>Unable to load achievements. Please try again.</strong><span class="muted">${esc(err.message)}</span></div>`;
    $("#achCount").textContent = "";
    return;
  }
  render();
  renderBoard();
})();

if ("serviceWorker" in navigator && !isNative) navigator.serviceWorker.register("./sw.js").catch(() => {});