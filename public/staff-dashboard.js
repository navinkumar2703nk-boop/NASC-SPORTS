const isNative = typeof window !== "undefined" && window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform();
const onLocalHost = typeof location !== "undefined" && /^(http|https):\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(location.origin);
const API_BASE = isNative || !onLocalHost ? "https://nasc-sports.onrender.com" : location.origin;

const $ = (s) => document.querySelector(s);

let events = [];
let registrations = [];
let feedback = [];
let maintenance = { enabled: false, message: "" };
let achievements = [];
let selected = new Set();

const state = {
  q: "",
  event: "all",
  dept: "all",
  year: "all",
  status: "all",
  dateRange: "all",
  from: "",
  to: "",
  sort: "name-asc",
  page: 1,
  perPage: 25,
  fbType: "all",
  fbQ: "",
  fbSort: "newest",
  expandedEvent: null,
  expandedFb: null,
  viewEvent: null,
  achQ: "",
  achSport: "all",
  achDept: "all",
  achLevel: "all",
  achYear: "all",
  achSort: "newest",
  expandedAch: null,
};

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
    throw new ApiError("Unable to connect to server. Please try again.");
  }

  let data = {};
  try { data = await res.json(); } catch {}

  if (!res.ok) {
    const fallback = {
      400: "Invalid request. Please check your details.",
      401: "Staff login required.",
      403: "Access denied.",
      404: "Not found.",
      500: "Something went wrong on the server. Please try again later.",
      503: "Service temporarily unavailable. Please try again.",
    };
    throw new ApiError(data.error || fallback[res.status] || "Something went wrong.", res.status, data);
  }
  return data;
}

function handleAuthError(err) {
  if (err && err.status === 401) location.replace("./staff-login.html");
}

function esc(v = "") {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

function fmtDate(d) {
  if (!d) return "";
  return new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(stamp) {
  if (!stamp) return "";
  const d = new Date(stamp.replace(" ", "T") + "Z");
  if (isNaN(d)) return stamp;
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function regUTCDay(stamp) {
  const d = new Date(stamp.replace(" ", "T") + "Z");
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()].join("-");
}

function todayUTC() {
  const d = new Date();
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()].join("-");
}

function weekStartUTC() {
  const d = new Date();
  const day = d.getUTCDay();
  const sub = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - sub);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()].join("-");
}

function monthStartUTC() {
  const d = new Date();
  return [d.getUTCFullYear(), d.getUTCMonth(), 1].join("-");
}

function eventById(id) {
  return events.find((e) => e.id === id);
}

function isEventOpen(r) {
  const e = eventById(r.event_id);
  return !!(e && e.registration_enabled);
}

function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

// ---------------------------------------------------------------- toasts
function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "toast " + (kind || "ok");
  el.innerHTML = `<span class="toast-dot"></span><span>${esc(msg)}</span>`;
  $("#toasts").appendChild(el);
  setTimeout(() => el.classList.add("out"), 3600);
  setTimeout(() => el.remove(), 4000);
}

// ---------------------------------------------------------------- confirm modal
function confirmDialog(msg, opts = {}) {
  return new Promise((resolve) => {
    $("#confirmMsg").textContent = msg;
    $("#confirmTitle").textContent = opts.title || "Confirm";
    const yesBtn = $("#confirmYes");
    yesBtn.textContent = opts.yesText || "Confirm";
    yesBtn.className = "button " + (opts.danger ? "danger" : "primary");
    $("#confirmModal").classList.remove("hidden");

    const done = (val) => {
      $("#confirmModal").classList.add("hidden");
      yesBtn.onclick = null;
      $("#confirmNo").onclick = null;
      resolve(val);
    };
    yesBtn.onclick = () => done(true);
    $("#confirmNo").onclick = () => done(false);
  });
}

// ---------------------------------------------------------------- auth + boot
async function loadEvents() { events = await api("/api/events"); }
async function loadRegistrations() { registrations = await api("/api/registrations"); }
async function loadFeedback() { feedback = await api("/api/feedback"); }
async function loadMaintenance() { maintenance = await api("/api/maintenance"); }
async function loadAchievements() { achievements = await api("/api/achievements"); }

async function refreshAll(showLoading) {
  if (showLoading) { const el = $("#loading"); if (el) el.style.display = ""; }
  selected.clear();
  try {
    const [session, evs, regs, fb, maint, achs] = await Promise.all([
      api("/api/session"),
      loadEvents(),
      loadRegistrations(),
      loadFeedback(),
      loadMaintenance(),
      loadAchievements(),
    ]);
    if (!session || !session.staff) {
      location.replace("./staff-login.html");
      return;
    }
    if (state.viewEvent && !eventById(state.viewEvent)) state.viewEvent = null;
    renderAll();
  } catch (err) {
    handleAuthError(err);
    setStatus($("#dashStatus"), err.message, "err");
    toast(err.message, "err");
  } finally {
    const el = $("#loading"); if (el) el.style.display = "none";
  }
}

function renderAll() {
  renderEvents();
  renderMaintenanceBanner();
  renderRegTable();
  renderFeedback();
  renderAchievements();
}

// ---------------------------------------------------------------- EVENT management: compact -> expand
window.toggleEvent = (id) => {
  state.expandedEvent = state.expandedEvent === id ? null : id;
  renderEvents();
};

function renderEvents() {
  const counts = {};
  registrations.forEach((r) => { counts[r.event_id] = (counts[r.event_id] || 0) + 1; });

  $("#eventAccordion").innerHTML = events.length
    ? events.map((e) => {
        const open = !!e.registration_enabled;
        const cnt = counts[e.id] || 0;
        const exp = state.expandedEvent === e.id;
        return `<div class="ev-card ${exp ? "open" : ""}" data-id="${e.id}">
          <button type="button" class="ev-head" onclick="toggleEvent(${e.id})">
            <span class="ev-head-top">
              <span class="badge badge-type">${esc(e.type)}</span>
              <span class="badge ${open ? "badge-open" : "badge-closed"}"><span class="dot"></span>${open ? "OPEN" : "CLOSED"}</span>
            </span>
            <strong class="ev-name">${esc(e.title)}</strong>
            <span class="ev-meta">${esc(fmtDate(e.date))} · ${esc(e.time || "Time TBA")} · ${esc(e.venue || "Venue TBA")}</span>
            <span class="ev-foot">
              <span class="ev-count">${cnt} Registered</span>
              <span class="chev ${exp ? "open" : ""}">&#8250;</span>
            </span>
          </button>
          <div class="ev-body">
            <div class="ev-details">
              <div class="ev-detail"><span>Title</span><strong>${esc(e.title)}</strong></div>
              <div class="ev-detail"><span>Type</span><strong>${esc(e.type)}</strong></div>
              <div class="ev-detail"><span>Date</span><strong>${esc(fmtDate(e.date))}</strong></div>
              <div class="ev-detail"><span>Time</span><strong>${esc(e.time || "Time TBA")}</strong></div>
              <div class="ev-detail"><span>Venue</span><strong>${esc(e.venue || "Venue TBA")}</strong></div>
              <div class="ev-detail"><span>Status</span><strong><span class="badge ${open ? "badge-open" : "badge-closed"}"><span class="dot"></span>${open ? "OPEN" : "CLOSED"}</span></strong></div>
              <div class="ev-detail"><span>Registered</span><strong>${cnt} student${cnt === 1 ? "" : "s"}</strong></div>
            </div>
            ${e.description ? `<p class="ev-desc">${esc(e.description)}</p>` : ""}
            <div class="ev-actions">
              <button type="button" class="button secondary small" onclick="editEvent(${e.id})">Edit</button>
              <button type="button" class="button secondary small" onclick="viewEventStudents(${e.id})">View Registered Students</button>
              <button type="button" class="button secondary small" onclick="toggleRegistration(${e.id}, ${open ? "false" : "true"})">${open ? "Close Registration" : "Reopen Registration"}</button>
              <button type="button" class="button secondary small danger-btn" onclick="deleteEvent(${e.id})">Delete</button>
            </div>
          </div>
        </div>`;
      }).join("")
    : `<p class="muted">No events yet. Use the Add Event button to create the first one.</p>`;
}

// ---------------------------------------------------------------- event modal (add / edit)
function openEventModal(id) {
  const modal = $("#eventModal");
  $("#eventForm").reset();
  $("#eventId").value = "";
  $("#eventStatus").textContent = "";
  $("#eventStatus").className = "status";
  const e = id != null ? eventById(id) : null;
  if (e) {
    $("#eventId").value = e.id;
    $("#eventTitle").value = e.title;
    $("#eventType").value = e.type;
    $("#eventDate").value = e.date;
    $("#eventTime").value = e.time;
    $("#eventVenue").value = e.venue;
    $("#eventDescription").value = e.description;
    $("#registrationEnabled").checked = !!e.registration_enabled;
  }
  $("#eventModalTitle").textContent = e ? "Edit Event" : "Add Event";
  $("#saveEventBtn").textContent = e ? "Update Event" : "Save Event";
  modal.classList.remove("hidden");
  setTimeout(() => $("#eventTitle").focus(), 60);
}

window.editEvent = (id) => openEventModal(id);

window.closeEventModal = () => $("#eventModal").classList.add("hidden");

$("#eventForm").onsubmit = async (e) => {
  e.preventDefault();
  const id = Number($("#eventId").value) || null;
  const data = {
    title: $("#eventTitle").value,
    type: $("#eventType").value,
    description: $("#eventDescription").value,
    date: $("#eventDate").value,
    time: $("#eventTime").value,
    venue: $("#eventVenue").value,
    registration_enabled: $("#registrationEnabled").checked,
  };
  setStatus($("#eventStatus"), "Saving...");
  try {
    await api(id ? `/api/events/${id}` : "/api/events", { method: id ? "PUT" : "POST", body: JSON.stringify(data) });
    closeEventModal();
    toast(id ? "Event updated successfully." : "Event added successfully.", "ok");
    await refreshAll(false);
  } catch (err) {
    handleAuthError(err);
    setStatus($("#eventStatus"), err.message, "err");
  }
};

// ---------------------------------------------------------------- maintenance mode
function renderMaintenanceBanner() {
  const on = !!(maintenance && maintenance.enabled);
  $("#maintBanner").classList.toggle("hidden", !on);
}

function openMaintModal() {
  $("#maintEnabled").checked = !!maintenance.enabled;
  $("#maintMessage").value = maintenance.message || "";
  $("#maintStatus").textContent = "";
  $("#maintStatus").className = "status";
  $("#maintModal").classList.remove("hidden");
}

window.closeMaintModal = () => $("#maintModal").classList.add("hidden");

$("#maintForm").onsubmit = async (e) => {
  e.preventDefault();
  setStatus($("#maintStatus"), "Saving...");
  try {
    const res = await api("/api/maintenance", {
      method: "POST",
      body: JSON.stringify({ enabled: $("#maintEnabled").checked, message: $("#maintMessage").value }),
    });
    maintenance = { enabled: !!res.enabled, message: res.message || "" };
    closeMaintModal();
    renderMaintenanceBanner();
    toast(res.enabled ? "Maintenance mode turned ON." : "Maintenance mode turned OFF.", "ok");
  } catch (err) {
    handleAuthError(err);
    setStatus($("#maintStatus"), err.message, "err");
  }
};

$("#closeMaintModal").onclick = window.closeMaintModal;
$("#cancelMaintModal").onclick = window.closeMaintModal;

// ---------------------------------------------------------------- change password
function openPwModal() {
  $("#pwForm").reset();
  $("#pwStatus").textContent = "";
  $("#pwStatus").className = "status";
  $("#pwModal").classList.remove("hidden");
  setTimeout(() => $("#pwCurrent").focus(), 60);
}

window.closePwModal = () => $("#pwModal").classList.add("hidden");

$("#pwForm").onsubmit = async (e) => {
  e.preventDefault();
  const current = $("#pwCurrent").value;
  const next = $("#pwNew").value;
  const confirm = $("#pwConfirm").value;
  if (!current) return setStatus($("#pwStatus"), "Enter your current password.", "err");
  if (next.length < 6) return setStatus($("#pwStatus"), "New password must be at least 6 characters.", "err");
  if (next !== confirm) return setStatus($("#pwStatus"), "New password and confirmation do not match.", "err");
  setStatus($("#pwStatus"), "Saving...");
  try {
    await api("/api/change-password", {
      method: "POST",
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
    closePwModal();
    toast("Password changed successfully.", "ok");
  } catch (err) {
    handleAuthError(err);
    setStatus($("#pwStatus"), err.message, "err");
  }
};

$("#closePwModal").onclick = window.closePwModal;
$("#cancelPwModal").onclick = window.closePwModal;

// ---------------------------------------------------------------- toggle registration
window.toggleRegistration = async (id, enabled) => {
  try {
    await api(`/api/events/${id}/registration`, { method: "POST", body: JSON.stringify({ enabled }) });
    const e = eventById(id);
    if (e) e.registration_enabled = enabled ? 1 : 0;
    await Promise.all([loadRegistrations()]);
    renderAll();
    toast(enabled ? "Registration reopened successfully." : "Registration closed successfully.", "ok");
  } catch (err) {
    handleAuthError(err);
    toast(err.message, "err");
  }
};

// ---------------------------------------------------------------- event -> student view
window.viewEventStudents = (id) => {
  state.viewEvent = id;
  state.page = 1;
  renderRegTable();
  const sec = $("#regSection");
  if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
};

window.clearEventView = () => {
  state.viewEvent = null;
  state.event = "all";
  $("#filterEvent").value = "all";
  state.page = 1;
  renderRegTable();
};

// ---------------------------------------------------------------- delete event
window.deleteEvent = async (id) => {
  const e = eventById(id);
  if (!e) return;
  const cnt = registrations.filter((r) => r.event_id === id).length;
  const msg = cnt
    ? `This event has ${cnt} registered student${cnt === 1 ? "" : "s"}. Deleting the event will also delete its registrations. Continue?`
    : `Delete event "${e.title}"?`;
  const ok = await confirmDialog(msg, { title: "Delete event", yesText: "Delete Event", danger: true });
  if (!ok) return;
  try {
    await api(`/api/events/${id}`, { method: "DELETE" });
    if (state.viewEvent === id) state.viewEvent = null;
    await refreshAll(false);
    toast("Event deleted successfully.", "ok");
  } catch (err) {
    handleAuthError(err);
    toast(err.message, "err");
  }
};

// ---------------------------------------------------------------- registered students: filters + list
function applyFilters() {
  let list = registrations.slice();

  if (state.viewEvent) list = list.filter((r) => r.event_id === state.viewEvent);
  else if (state.event !== "all") list = list.filter((r) => String(r.event_id) === state.event);
  if (state.dept !== "all") list = list.filter((r) => r.department === state.dept);
  if (state.year !== "all") list = list.filter((r) => r.year === state.year);
  if (state.status === "open") list = list.filter((r) => isEventOpen(r));
  if (state.status === "closed") list = list.filter((r) => !isEventOpen(r));

  if (state.dateRange !== "all") {
    const today = todayUTC();
    const weekStart = weekStartUTC();
    const monthStart = monthStartUTC();
    list = list.filter((r) => {
      const day = regUTCDay(r.created_at);
      if (state.dateRange === "today") return day === today;
      if (state.dateRange === "week") return day >= weekStart && day <= today;
      if (state.dateRange === "month") return day >= monthStart && day <= today;
      if (state.dateRange === "custom") {
        if (state.from && day < state.from) return false;
        if (state.to && day > state.to) return false;
        return true;
      }
      return true;
    });
  }

  const q = state.q.toLowerCase().trim();
  if (q) {
    list = list.filter((r) =>
      [r.name, r.roll_no, r.department, r.phone, r.event_title].join(" ").toLowerCase().includes(q)
    );
  }

  list.sort(sortFn);
  return list;
}

function sortFn(a, b) {
  switch (state.sort) {
    case "name-desc": return b.name.localeCompare(a.name);
    case "roll": return String(a.roll_no).localeCompare(String(b.roll_no), undefined, { numeric: true });
    case "dept": return a.department.localeCompare(b.department);
    case "year": return a.year.localeCompare(b.year);
    case "regdate": return String(b.created_at).localeCompare(String(a.created_at));
    case "eventdate": return String(a.event_date).localeCompare(String(b.event_date)) || String(b.created_at).localeCompare(String(a.created_at));
    default: return a.name.localeCompare(b.name);
  }
}

function renderStats(list) {
  $("#statTotal").textContent = list.length;
  const today = todayUTC();
  $("#statToday").textContent = list.filter((r) => regUTCDay(r.created_at) === today).length;
  $("#statEvents").textContent = new Set(list.map((r) => r.event_id)).size;
  $("#statOpen").textContent = list.filter((r) => isEventOpen(r)).length;
}

function populateDropdowns() {
  const eventSel = $("#filterEvent");
  const deptSel = $("#filterDept");
  const yearSel = $("#filterYear");

  const currentEvent = state.viewEvent ? String(state.viewEvent) : state.event;
  const currentDept = state.dept;
  const currentYear = state.year;

  eventSel.innerHTML = `<option value="all">All Events</option>` + events.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join("");
  const depts = [...new Set(registrations.map((r) => r.department).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  deptSel.innerHTML = `<option value="all">All Departments</option>` + depts.map((d) => `<option>${esc(d)}</option>`).join("");
  const years = [...new Set(registrations.map((r) => r.year).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  yearSel.innerHTML = `<option value="all">All Years</option>` + years.map((y) => `<option>${esc(y)}</option>`).join("");

  if (events.some((e) => String(e.id) === currentEvent)) eventSel.value = currentEvent;
  if (depts.some((d) => d === currentDept)) deptSel.value = currentDept;
  if (years.some((y) => y === currentYear)) yearSel.value = currentYear;
}

function renderEventBanner() {
  const ve = state.viewEvent ? eventById(state.viewEvent) : null;
  const banner = $("#viewEventBanner");
  if (ve) {
    const cnt = registrations.filter((r) => r.event_id === ve.id).length;
    $("#viewEventTitle").textContent = ve.title;
    $("#viewEventCount").textContent = `${cnt} Student${cnt === 1 ? "" : "s"} Registered`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

function renderRegTable() {
  populateDropdowns();
  renderEventBanner();
  const list = applyFilters();

  renderStats(list);

  const pages = Math.max(1, Math.ceil(list.length / state.perPage));
  if (state.page > pages) state.page = pages;
  if (state.page < 1) state.page = 1;

  const start = (state.page - 1) * state.perPage;
  const pageRows = list.slice(start, start + state.perPage);

  const stillSelected = Array.from(selected).filter((id) => list.some((r) => r.id === id));
  if (stillSelected.length !== selected.size) selected = new Set(stillSelected);
  $("#deleteSelectedBtn").disabled = selected.size === 0;

  $("#regBody").innerHTML = pageRows.length
    ? pageRows.map((r) => `
        <tr data-id="${r.id}">
          <td class="col-check"><input type="checkbox" class="row-check" value="${r.id}" ${selected.has(r.id) ? "checked" : ""}></td>
          <td data-label="Student"><strong>${esc(r.name)}</strong></td>
          <td data-label="Roll No.">${esc(r.roll_no)}</td>
          <td data-label="Department">${esc(r.department)}</td>
          <td data-label="Year">${esc(r.year)}</td>
          <td data-label="Phone">${esc(r.phone || "—")}</td>
          <td data-label="Event">${esc(r.event_title)} <span class="badge small ${isEventOpen(r) ? "badge-open" : "badge-closed"}">${isEventOpen(r) ? "OPEN" : "CLOSED"}</span></td>
          <td data-label="Registered On">${esc(fmtDate(r.created_at ? r.created_at.slice(0, 10) : ""))} <small class="muted">${esc(fmtDateTime(r.created_at))}</small></td>
          <td class="col-actions" data-label="Actions"><button type="button" class="small-btn danger-btn" onclick="deleteRegistration(${r.id})">Delete</button></td>
        </tr>`).join("")
    : `<tr><td colspan="9" class="muted">No registrations match the current filters.</td></tr>`;

  $("#selectAll").checked = pageRows.length > 0 && pageRows.every((r) => selected.has(r.id));
  $("#selectAll").indeterminate = pageRows.some((r) => selected.has(r.id)) && !$("#selectAll").checked;

  renderPager(list.length, pages, start, pageRows.length);
}

function renderPager(total, pages, start, shown) {
  $("#rangeText").textContent = total ? `Showing ${start + 1}–${start + shown} of ${total} registrations` : "No registrations";
  $("#prevPage").disabled = state.page <= 1;
  $("#nextPage").disabled = state.page >= pages;

  let nums = "";
  const from = Math.max(1, state.page - 2);
  const to = Math.min(pages, state.page + 2);
  for (let i = from; i <= to; i++) {
    nums += `<button type="button" class="page-btn ${i === state.page ? "active" : ""}" data-page="${i}">${i}</button>`;
  }
  $("#pageNumbers").innerHTML = nums;
}

// ---------------------------------------------------------------- registration actions
window.deleteRegistration = async (id) => {
  const ok = await confirmDialog("Delete this registration?", { title: "Delete registration", yesText: "Delete", danger: true });
  if (!ok) return;
  try {
    await api(`/api/registrations/${id}`, { method: "DELETE" });
    selected.delete(id);
    await refreshAll(false);
    toast("Registration deleted.", "ok");
  } catch (err) {
    handleAuthError(err);
    toast(err.message, "err");
  }
};

window.deleteSelected = async () => {
  const n = selected.size;
  if (!n) return;
  const ok = await confirmDialog(`Delete ${n} selected registration${n === 1 ? "" : "s"}?`, { title: "Delete selected", yesText: "Delete Selected", danger: true });
  if (!ok) return;
  try {
    let done = 0;
    for (const id of Array.from(selected)) {
      await api(`/api/registrations/${id}`, { method: "DELETE" });
      done++;
    }
    toast(`${done} registration${done === 1 ? "" : "s"} deleted.`, "ok");
    selected.clear();
    await refreshAll(false);
  } catch (err) {
    handleAuthError(err);
    toast(err.message, "err");
  }
};

// ---------------------------------------------------------------- CSV export (respects active filters)
function csvCell(v) {
  v = String(v == null ? "" : v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function exportCSV() {
  const rows = applyFilters();
  const header = ["Event", "Student Name", "Department", "Year", "Roll Number", "Phone", "Registration Date"];
  const lines = [header.join(",")];
  rows.forEach((r) => {
    lines.push([
      csvCell(r.event_title),
      csvCell(r.name),
      csvCell(r.department),
      csvCell(r.year),
      csvCell(r.roll_no),
      csvCell(r.phone),
      csvCell(fmtDate(r.created_at ? r.created_at.slice(0, 10) : "")),
    ].join(","));
  });
  const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "nasc-sports-registrations.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  toast(`Exported ${rows.length} registration${rows.length === 1 ? "" : "s"}.`, "ok");
}

// ---------------------------------------------------------------- feedback (compact -> expand)
window.toggleFb = (id) => {
  state.expandedFb = state.expandedFb === id ? null : id;
  renderFeedback();
};

function previewMsg(m, n) {
  return m.length > n ? m.slice(0, n).trimEnd() + "…" : m;
}

function renderFeedback() {
  $("#fbCountAll").textContent = feedback.length;
  const enq = feedback.filter((f) => f.kind === "enquiry").length;
  $("#fbCountEnquiry").textContent = enq;
  $("#fbCountComplaint").textContent = feedback.length - enq;

  let list = feedback.slice();
  if (state.fbType !== "all") list = list.filter((f) => f.kind === state.fbType);
  const q = state.fbQ.toLowerCase().trim();
  if (q) list = list.filter((f) => f.message.toLowerCase().includes(q));
  list.sort((a, b) => (state.fbSort === "oldest" ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)));

  $("#feedbackList").innerHTML = list.length
    ? list.map((f) => {
        const exp = state.expandedFb === f.id;
        return `<div class="fb-card ${exp ? "open" : ""}" data-id="${f.id}">
          <button type="button" class="fb-head" onclick="toggleFb(${f.id})">
            <span class="badge ${f.kind === "complaint" ? "badge-closed" : "badge-open"}">${esc(f.kind)}</span>
            <span class="fb-preview muted">${esc(previewMsg(f.message, 80))}</span>
            <span class="chev ${exp ? "open" : ""}">&#8250;</span>
          </button>
          <div class="fb-body ${exp ? "" : "hidden"}">
            <p class="fb-full">${esc(f.message)}</p>
            <div class="fb-meta">
              <span class="muted">${esc(fmtDateTime(f.created_at))}</span>
              <button type="button" class="small-btn danger-btn" onclick="deleteFeedback(${f.id})">Delete</button>
            </div>
          </div>
        </div>`;
      }).join("")
    : `<p class="muted">No messages match the current filters.</p>`;
}

window.deleteFeedback = async (id) => {
  const ok = await confirmDialog("Delete this message?", { title: "Delete message", yesText: "Delete", danger: true });
  if (!ok) return;
  try {
    await api(`/api/feedback/${id}`, { method: "DELETE" });
    if (state.expandedFb === id) state.expandedFb = null;
    await loadFeedback();
    renderFeedback();
    toast("Message deleted.", "ok");
  } catch (err) {
    handleAuthError(err);
    toast(err.message, "err");
  }
};

// ---------------------------------------------------------------- student achievements: list + filters
function photoUrl(p) {
  if (!p) return "";
  if (/^(https?:)?\/\//.test(p)) return p;
  return API_BASE + (p.charAt(0) === "/" ? p : "/" + p);
}

window.toggleAch = (id) => {
  state.expandedAch = state.expandedAch === id ? null : id;
  renderAchievements();
};

function achAppliedList() {
  let list = achievements.slice();
  if (state.achSport !== "all") list = list.filter((a) => a.sport === state.achSport);
  if (state.achDept !== "all") list = list.filter((a) => a.department === state.achDept);
  if (state.achLevel !== "all") list = list.filter((a) => a.level === state.achLevel);
  if (state.achYear !== "all") list = list.filter((a) => a.achievement_year === state.achYear);

  const q = state.achQ.toLowerCase().trim();
  if (q) {
    list = list.filter((a) =>
      [a.student_name, a.roll_no, a.sport, a.title, a.competition, a.department].join(" ").toLowerCase().includes(q)
    );
  }

  list.sort((x, y) => {
    if (state.achSort === "oldest") return String(x.created_at).localeCompare(String(y.created_at));
    if (state.achSort === "name-asc") return x.student_name.localeCompare(y.student_name);
    if (state.achSort === "name-desc") return y.student_name.localeCompare(x.student_name);
    return String(y.created_at).localeCompare(String(x.created_at));
  });
  return list;
}

function populateAchDropdowns() {
  const sports = [...new Set(achievements.map((a) => (a.sport || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const depts = [...new Set(achievements.map((a) => (a.department || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const levels = ["College", "Inter-College", "Zonal", "District", "State", "National", "International", "Other"].filter((l) => achievements.some((a) => a.level === l));
  const years = [...new Set(achievements.map((a) => (a.achievement_year || "").trim()).filter(Boolean))].sort();

  const keep = {
    sport: $("#achFilterSport").value,
    dept: $("#achFilterDept").value,
    level: $("#achFilterLevel").value,
    year: $("#achFilterYear").value,
  };
  $("#achFilterSport").innerHTML = `<option value="all">All Sports</option>` + sports.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#achFilterDept").innerHTML = `<option value="all">All Departments</option>` + depts.map((d) => `<option>${esc(d)}</option>`).join("");
  $("#achFilterLevel").innerHTML = `<option value="all">All Levels</option>` + levels.map((l) => `<option>${esc(l)}</option>`).join("");
  $("#achFilterYear").innerHTML = `<option value="all">All Years</option>` + years.map((y) => `<option>${esc(y)}</option>`).join("");
  if (sports.includes(keep.sport)) $("#achFilterSport").value = keep.sport;
  if (depts.includes(keep.dept)) $("#achFilterDept").value = keep.dept;
  if (levels.includes(keep.level)) $("#achFilterLevel").value = keep.level;
  if (years.includes(keep.year)) $("#achFilterYear").value = keep.year;
}

function renderAchievements() {
  populateAchDropdowns();
  const list = achAppliedList();
  $("#achievementList").innerHTML = list.length
    ? list.map((a) => {
        const exp = state.expandedAch === a.id;
        return `<div class="ach-row ${exp ? "open" : ""}">
          <button type="button" class="ev-head" onclick="toggleAch(${a.id})">
            <span class="ach-head-main">
              <img class="ach-face" src="${esc(photoUrl(a.photo))}" alt="" onerror="this.style.visibility='hidden'">
              <span class="ach-head-text">
                <strong class="ev-name">${esc(a.student_name)} — ${esc(a.title)}</strong>
                <span class="ev-meta">${esc(a.department || "—")}${a.year ? ` · ${esc(a.year)}` : ""} · ${esc(a.sport)} · ${esc(a.level)}</span>
              </span>
              <span class="chev ${exp ? "open" : ""}">&#8250;</span>
            </span>
          </button>
          <div class="ev-body">
            ${a.photo ? `<img class="ach-detail-photo" src="${esc(photoUrl(a.photo))}" alt="${esc(a.student_name)}">` : ""}
            <div class="ev-details">
              <div class="ev-detail"><span>Student Name</span><strong>${esc(a.student_name)}</strong></div>
              <div class="ev-detail"><span>Department</span><strong>${esc(a.department || "—")}</strong></div>
              <div class="ev-detail"><span>Year / Semester</span><strong>${esc(a.year || "—")}</strong></div>
              <div class="ev-detail"><span>Roll Number</span><strong>${esc(a.roll_no || "—")}</strong></div>
              <div class="ev-detail"><span>Sport</span><strong>${esc(a.sport)}</strong></div>
              <div class="ev-detail"><span>Achievement</span><strong>${esc(a.title)}</strong></div>
              <div class="ev-detail"><span>Competition</span><strong>${esc(a.competition || "—")}</strong></div>
              <div class="ev-detail"><span>Level</span><strong>${esc(a.level)}</strong></div>
              <div class="ev-detail"><span>Position / Result</span><strong>${esc(a.position || "—")}</strong></div>
              <div class="ev-detail"><span>Achievement Date / Year</span><strong>${esc(a.achievement_year || "—")}</strong></div>
            </div>
            ${a.description ? `<p class="ev-desc">${esc(a.description)}</p>` : ""}
            <div class="ev-actions">
              <button type="button" class="button secondary small" onclick="editAchievement(${a.id})">Edit</button>
              <button type="button" class="button secondary small danger-btn" onclick="deleteAchievement(${a.id})">Delete</button>
            </div>
          </div>
        </div>`;
      }).join("")
    : `<p class="muted">${achievements.length ? "No achievements match the current filters." : "No achievements yet. Use the Add Achievement button to add the first one."}</p>`;
}

// ---------------------------------------------------------------- achievement modal (add / edit)
let achPhotoDataUrl = null;

window.editAchievement = (id) => openAchievementModal(id);
window.closeAchievementModal = () => $("#achievementModal").classList.add("hidden");

function achResize(file) {
  return new Promise((resolve, reject) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      reject(new Error("Unsupported image format. Please upload JPG, JPEG, PNG or WEBP."));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error("Image is too large. Maximum size is 5 MB."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read the image file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Unable to read the image file."));
      img.onload = () => {
        const MAX = 1000;
        let { width: w, height: h } = img;
        if (w > MAX || h > MAX) {
          const s = Math.min(MAX / w, MAX / h);
          w = Math.round(w * s);
          h = Math.round(h * s);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function openAchievementModal(id) {
  const a = id != null ? achievements.find((x) => x.id === id) : null;
  $("#achievementForm").reset();
  $("#achievementStatus").textContent = "";
  $("#achievementStatus").className = "status";
  achPhotoDataUrl = null;

  if (a) {
    $("#achievementId").value = a.id;
    $("#achStudentName").value = a.student_name;
    $("#achDepartment").value = a.department;
    $("#achYear").value = a.year;
    $("#achRollNo").value = a.roll_no;
    $("#achSport").value = a.sport;
    $("#achTitle").value = a.title;
    $("#achDescription").value = a.description;
    $("#achCompetition").value = a.competition;
    $("#achLevel").value = ["College", "Inter-College", "Zonal", "District", "State", "National", "International", "Other"].includes(a.level) ? a.level : "Other";
    $("#achPosition").value = a.position;
    $("#achAchievementYear").value = a.achievement_year;
  }

  $("#achievementModalTitle").textContent = a ? "Edit Student Achievement" : "Add Student Achievement";
  $("#saveAchievementBtn").textContent = a ? "Update Achievement" : "Save Achievement";

  const preview = $("#achPhotoPreview");
  const img = $("#achPhotoImg");
  $("#achPhotoInput").value = "";
  if (a && a.photo) {
    img.src = photoUrl(a.photo);
    preview.classList.remove("hidden");
  } else {
    img.removeAttribute("src");
    preview.classList.add("hidden");
  }

  $("#achievementModal").classList.remove("hidden");
  setTimeout(() => $("#achStudentName").focus(), 60);
}

$("#achPhotoInput").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  const preview = $("#achPhotoPreview");
  if (!file) { preview.classList.add("hidden"); achPhotoDataUrl = null; return; }
  try {
    const dataUrl = await achResize(file);
    achPhotoDataUrl = dataUrl;
    $("#achPhotoImg").src = dataUrl;
    preview.classList.remove("hidden");
  } catch (err) {
    achPhotoDataUrl = null;
    e.target.value = "";
    setStatus($("#achievementStatus"), err.message, "err");
  }
});

$("#achPhotoRemove").addEventListener("click", () => {
  achPhotoDataUrl = null;
  $("#achPhotoInput").value = "";
  $("#achPhotoImg").removeAttribute("src");
  $("#achPhotoPreview").classList.add("hidden");
  setStatus($("#achievementStatus"), "", "");
});

$("#achievementForm").onsubmit = async (e) => {
  e.preventDefault();
  const id = Number($("#achievementId").value) || null;
  const data = {
    student_name: $("#achStudentName").value.trim(),
    department: $("#achDepartment").value.trim(),
    year: $("#achYear").value.trim(),
    roll_no: $("#achRollNo").value.trim(),
    sport: $("#achSport").value.trim(),
    title: $("#achTitle").value.trim(),
    description: $("#achDescription").value.trim(),
    competition: $("#achCompetition").value.trim(),
    level: $("#achLevel").value,
    position: $("#achPosition").value.trim(),
    achievement_year: $("#achAchievementYear").value.trim(),
  };
  if (!data.student_name || !data.department || !data.sport || !data.title) {
    setStatus($("#achievementStatus"), "Please fill all required fields.", "err");
    return;
  }
  if (id == null && !achPhotoDataUrl) {
    setStatus($("#achievementStatus"), "Student photo is required.", "err");
    return;
  }
  if (achPhotoDataUrl) data.photo_data = achPhotoDataUrl;

  setStatus($("#achievementStatus"), "Saving...");
  try {
    await api(id ? `/api/achievements/${id}` : "/api/achievements", { method: id ? "PUT" : "POST", body: JSON.stringify(data) });
    closeAchievementModal();
    toast(id ? "Achievement updated successfully." : "Achievement added successfully.", "ok");
    await loadAchievements();
    renderAchievements();
  } catch (err) {
    handleAuthError(err);
    setStatus($("#achievementStatus"), err.message, "err");
  }
};

window.deleteAchievement = async (id) => {
  const a = achievements.find((x) => x.id === id);
  if (!a) return;
  const ok = await confirmDialog(
    `Are you sure you want to delete this achievement? (${a.student_name} — ${a.title})`,
    { title: "Delete achievement", yesText: "Delete", danger: true }
  );
  if (!ok) return;
  try {
    await api(`/api/achievements/${id}`, { method: "DELETE" });
    if (state.expandedAch === id) state.expandedAch = null;
    achievements = achievements.filter((x) => x.id !== id);
    renderAchievements();
    toast("Achievement deleted successfully.", "ok");
  } catch (err) {
    handleAuthError(err);
    toast(err.message, "err");
  }
};

// ---------------------------------------------------------------- logout
$("#logoutBtn").onclick = async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    // Log out locally even if the network is unreachable.
  }
  location.replace("./staff-login.html");
};

// ---------------------------------------------------------------- bind UI
function bindUI() {
  $("#addEventBtn").onclick = () => openEventModal(null);
  $("#maintBtn").onclick = openMaintModal;
  $("#pwBtn").onclick = openPwModal;

  $("#closeEventModal").onclick = window.closeEventModal;
  $("#cancelEventModal").onclick = window.closeEventModal;
  $("#clearEventViewBtn").onclick = window.clearEventView;

  const onFilterChange = () => { state.page = 1; renderRegTable(); };
  $("#regSearch").addEventListener("input", (e) => { state.q = e.target.value; state.page = 1; renderRegTable(); });
  $("#filterEvent").addEventListener("change", (e) => {
    state.event = e.target.value;
    state.viewEvent = null;
    onFilterChange();
  });
  $("#filterDept").addEventListener("change", (e) => { state.dept = e.target.value; onFilterChange(); });
  $("#filterYear").addEventListener("change", (e) => { state.year = e.target.value; onFilterChange(); });
  $("#filterStatus").addEventListener("change", (e) => { state.status = e.target.value; onFilterChange(); });
  $("#filterDate").addEventListener("change", (e) => {
    state.dateRange = e.target.value;
    const custom = state.dateRange === "custom";
    $("#filterFrom").parentElement.style.display = custom ? "" : "none";
    $("#filterTo").parentElement.style.display = custom ? "" : "none";
    onFilterChange();
  });
  $("#filterFrom").addEventListener("change", (e) => { state.from = e.target.value; state.page = 1; renderRegTable(); });
  $("#filterTo").addEventListener("change", (e) => { state.to = e.target.value; state.page = 1; renderRegTable(); });
  $("#regSort").addEventListener("change", (e) => { state.sort = e.target.value; state.page = 1; renderRegTable(); });
  $("#perPage").addEventListener("change", (e) => { state.perPage = Number(e.target.value); state.page = 1; renderRegTable(); });

  $("#prevPage").onclick = () => { if (state.page > 1) { state.page--; renderRegTable(); } };
  $("#nextPage").onclick = () => { state.page++; renderRegTable(); };
  $("#pageNumbers").addEventListener("click", (e) => {
    const b = e.target.closest("[data-page]");
    if (b) { state.page = Number(b.dataset.page); renderRegTable(); }
  });

  $("#selectAll").addEventListener("change", (e) => {
    const list = applyFilters();
    const pageRows = list.slice((state.page - 1) * state.perPage, state.page * state.perPage);
    pageRows.forEach((r) => (e.target.checked ? selected.add(r.id) : selected.delete(r.id)));
    renderRegTable();
  });

  $("#regBody").addEventListener("change", (e) => {
    if (e.target.classList.contains("row-check")) {
      e.target.checked ? selected.add(Number(e.target.value)) : selected.delete(Number(e.target.value));
      $("#deleteSelectedBtn").disabled = selected.size === 0;
      const list = applyFilters();
      const pageRows = list.slice((state.page - 1) * state.perPage, state.page * state.perPage);
      $("#selectAll").checked = pageRows.length > 0 && pageRows.every((r) => selected.has(r.id));
      $("#selectAll").indeterminate = pageRows.some((r) => selected.has(r.id)) && !$("#selectAll").checked;
    }
  });

  $("#deleteSelectedBtn").onclick = window.deleteSelected;
  $("#exportCsvBtn").onclick = exportCSV;

  $("#refreshEvents").onclick = () => refreshAll(false);
  $("#regRefresh").onclick = () => refreshAll(false);
  $("#refreshFeedback").onclick = async () => { try { await loadFeedback(); renderFeedback(); } catch (err) { handleAuthError(err); } };

  $("#fbSearch").addEventListener("input", (e) => { state.fbQ = e.target.value; renderFeedback(); });
  $("#fbType").addEventListener("change", (e) => { state.fbType = e.target.value; state.expandedFb = null; renderFeedback(); });
  $("#fbSort").addEventListener("change", (e) => { state.fbSort = e.target.value; renderFeedback(); });

  $("#achAddBtn").onclick = () => openAchievementModal(null);
  $("#closeAchievementModal").onclick = window.closeAchievementModal;
  $("#cancelAchievementModal").onclick = window.closeAchievementModal;
  $("#achRefresh").onclick = async () => { try { await loadAchievements(); renderAchievements(); } catch (err) { handleAuthError(err); } };
  $("#achSearch").addEventListener("input", (e) => { state.achQ = e.target.value; renderAchievements(); });
  $("#achFilterSport").addEventListener("change", (e) => { state.achSport = e.target.value; renderAchievements(); });
  $("#achFilterDept").addEventListener("change", (e) => { state.achDept = e.target.value; renderAchievements(); });
  $("#achFilterLevel").addEventListener("change", (e) => { state.achLevel = e.target.value; renderAchievements(); });
  $("#achFilterYear").addEventListener("change", (e) => { state.achYear = e.target.value; renderAchievements(); });
  $("#achSort").addEventListener("change", (e) => { state.achSort = e.target.value; renderAchievements(); });

  $("#filterFrom").parentElement.style.display = "none";
  $("#filterTo").parentElement.style.display = "none";
}

// close modals on backdrop click
document.querySelectorAll(".modal").forEach((m) => {
  m.addEventListener("click", (e) => {
    if (e.target === m && ["eventModal", "maintModal", "pwModal", "achievementModal"].includes(m.id)) m.classList.add("hidden");
  });
});

// ---------------------------------------------------------------- init
(async function init() {
  bindUI();
  await refreshAll(true);
})();