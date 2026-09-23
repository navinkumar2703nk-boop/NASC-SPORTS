const isNative = typeof window !== "undefined" && window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform();
const onLocalHost = typeof location !== "undefined" && /^(http|https):\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(location.origin);
const API_BASE = isNative || !onLocalHost ? "https://nasc-sports.onrender.com" : location.origin;

const $ = (s) => document.querySelector(s);
let events = [];

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
      401: "Staff login required.",
      403: "Access denied.",
      404: "Not found.",
      500: "Server Error. Please try again later.",
      503: "Service Unavailable. Please try again later.",
    };
    if (res.status === 401) location.href = "./staff-login.html";
    throw new ApiError(data.error || fallback[res.status] || "Something went wrong.", res.status, data);
  }
  return data;
}

function esc(v = "") {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

function formatDate(d) {
  if (!d) return "";
  return new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

async function loadEvents() {
  try {
    events = await api("/api/events");
    const upcoming = events.filter((e) => e.date >= new Date().toISOString().slice(0, 10));
    $("#eventCount").textContent = upcoming.length;
    renderEvents(upcoming);
    renderRegistration(upcoming);
  } catch (err) {
    $("#eventGrid").innerHTML = `<div class="panel"><strong>${esc(err.message)}</strong><span class="muted">Please try again in a moment.</span></div>`;
    $("#registrationCards").innerHTML = "";
  }
}

function renderEvents(list) {
  const q = ($("#search")?.value || "").toLowerCase().trim();
  const filtered = list.filter((e) => [e.title, e.type, e.description, e.venue].join(" ").toLowerCase().includes(q));
  $("#eventGrid").innerHTML = filtered.length
    ? filtered.map((e) => `
      <article class="event-card">
        <span class="tag">${esc(e.type)}</span>
        <h3>${esc(e.title)}</h3>
        <p>${esc(e.description)}</p>
        <div class="event-meta">${esc(formatDate(e.date))} · ${esc(e.time || "Time TBA")} · ${esc(e.venue || "Venue TBA")}</div>
      </article>`).join("")
    : `<div class="panel"><strong>No matching events.</strong><span class="muted">Check another search term or come back after the department publishes a fixture.</span></div>`;
}

function renderRegistration(list) {
  $("#registrationCards").innerHTML = list.length
    ? list.map((e) => {
        const open = !!e.registration_enabled;
        return `<article class="registration-card ${open ? "" : "closed"}">
          <span class="tag ${open ? "" : "danger"}">${open ? "Registration open" : "Registration Closed"}</span>
          <h3>${esc(e.title)}</h3>
          <p>${esc(formatDate(e.date))} · ${esc(e.time || "Time TBA")} · ${esc(e.venue || "Venue TBA")}</p>
          ${open
            ? `<button class="button primary" onclick="openRegistration(${e.id})">Register Now</button>`
            : `<span class="reg-closed">Registration Closed</span>`}
        </article>`;
      }).join("")
    : `<div class="panel"><strong>No events are published yet.</strong><span class="muted">When the department publishes a fixture, it will appear here.</span></div>`;
}

window.openRegistration = function (id) {
  const e = events.find((x) => x.id === id);
  if (!e) return;
  const form = document.createElement("div");
  form.className = "modal";
  form.innerHTML = `<div class="modal-box">
    <button class="close" onclick="this.closest('.modal').remove()">×</button>
    <p class="eyebrow">STUDENT REGISTRATION</p>
    <h2>${esc(e.title)}</h2>
    <p class="muted">${esc(formatDate(e.date))} · ${esc(e.venue || "Venue TBA")}</p>
    <form id="regForm" autocomplete="off">
      <input name="name" placeholder="Full name *" required>
      <input name="department" placeholder="Department / course *" required>
      <input name="year" placeholder="Year / semester *" required>
      <input name="roll_no" placeholder="Roll number *" required>
      <label for="regPhone" class="field-label">Mobile Number *</label>
      <input id="regPhone" name="phone" type="tel" inputmode="numeric" pattern="[0-9]{10}" maxlength="10" placeholder="Enter 10 digit mobile number" title="Exactly 10 digits, numbers only" required>
      <button class="button primary" type="submit">Submit registration</button>
      <p id="regStatus" class="status"></p>
    </form>
  </div>`;
  document.body.appendChild(form);
  $("#regForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const statusEl = $("#regStatus");
    const phone = ev.target.elements.phone.value.trim();
    if (!/^\d{10}$/.test(phone)) {
      statusEl.textContent = "Please enter a valid 10-digit mobile number.";
      statusEl.className = "status err";
      return;
    }
    statusEl.textContent = "Submitting...";
    const data = Object.fromEntries(new FormData(ev.target));
    try {
      await api(`/api/events/${id}/register`, { method: "POST", body: JSON.stringify(data) });
      statusEl.textContent = "Registration submitted successfully.";
      statusEl.className = "status ok";
      ev.target.reset();
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = "status err";
    }
  };
};

$("#search").addEventListener("input", () => renderEvents(events.filter((e) => e.date >= new Date().toISOString().slice(0, 10))));

// ---------------------------------------------------------------- maintenance mode
function showMaintenance(msg) {
  const ov = document.createElement("div");
  ov.className = "maint-overlay";
  ov.innerHTML = `<div class="maint-box">
    <span class="mark">N</span>
    <h1>NASC <small>SPORTS</small></h1>
    <h2>Under Maintenance</h2>
    <p>${esc(msg || "We're currently updating the sports portal. Please check back soon.")}</p>
    <span class="pulse"></span>
  </div>`;
  document.body.appendChild(ov);
}

async function checkMaintenance() {
  try {
    const m = await api("/api/maintenance");
    if (m && m.enabled) showMaintenance(m.message);
    return !!(m && m.enabled);
  } catch {
    return false;
  }
}

(async function init() {
  if (await checkMaintenance()) return;
  loadEvents();
})();

$("#feedbackForm").onsubmit = async (e) => {
  e.preventDefault();
  const statusEl = $("#feedbackStatus");
  statusEl.textContent = "Sending...";
  statusEl.className = "status";
  try {
    await api("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ kind: $("#feedbackKind").value, message: $("#feedbackMessage").value }),
    });
    statusEl.textContent = "Submitted anonymously. Thank you.";
    statusEl.className = "status ok";
    $("#feedbackMessage").value = "";
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.className = "status err";
  }
};

if ("serviceWorker" in navigator && !isNative) navigator.serviceWorker.register("./sw.js").catch(() => {});