const API_BASE = "http://192.168.0.100:3000";

const $ = (s) => document.querySelector(s);
let events = [];
let staff = false;

async function api(url, options={}) {
  const res = await fetch(`${API_BASE}${url}`, {headers: {"Content-Type":"application/json"}, ...options});
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

function esc(v="") {
  return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function formatDate(d) {
  if (!d) return "";
  return new Date(d + "T00:00:00").toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"});
}

async function loadEvents() {
  events = await api("/api/events");
  const upcoming = events.filter(e => e.date >= new Date().toISOString().slice(0,10));
  $("#eventCount").textContent = upcoming.length;
  renderEvents(upcoming);
  renderRegistration(upcoming);
  if (staff) renderAdminEvents(events);
}

function renderEvents(list) {
  const q = ($("#search")?.value || "").toLowerCase().trim();
  const filtered = list.filter(e => [e.title,e.type,e.description,e.venue].join(" ").toLowerCase().includes(q));
  $("#eventGrid").innerHTML = filtered.length ? filtered.map(e => `
    <article class="event-card">
      <span class="tag">${esc(e.type)}</span>
      <h3>${esc(e.title)}</h3>
      <p>${esc(e.description)}</p>
      <div class="event-meta">${esc(formatDate(e.date))} · ${esc(e.time || "Time TBA")} · ${esc(e.venue || "Venue TBA")}</div>
    </article>`).join("") : `<div class="panel"><strong>No matching events.</strong><span class="muted">Check another search term or come back after the department publishes a fixture.</span></div>`;
}

function renderRegistration(list) {
  const open = list.filter(e => e.registration_enabled);
  $("#registrationCards").innerHTML = open.length ? open.map(e => `
    <article class="registration-card">
      <span class="tag">Registration open</span>
      <h3>${esc(e.title)}</h3>
      <p>${esc(formatDate(e.date))} · ${esc(e.time || "Time TBA")} · ${esc(e.venue || "Venue TBA")}</p>
      <button class="button primary" onclick="openRegistration(${e.id})">Register now</button>
    </article>`).join("") : `<div class="panel"><strong>No registrations are open right now.</strong><span class="muted">When staff enable registration for an event, it will appear here automatically.</span></div>`;
}

window.openRegistration = function(id) {
  const e = events.find(x => x.id === id);
  if (!e) return;
  const form = document.createElement("div");
  form.className = "modal";
  form.innerHTML = `<div class="modal-box">
    <button class="close" onclick="this.closest('.modal').remove()">×</button>
    <p class="eyebrow">STUDENT REGISTRATION</p>
    <h2>${esc(e.title)}</h2>
    <p class="muted">${esc(formatDate(e.date))} · ${esc(e.venue || "Venue TBA")}</p>
    <form id="regForm">
      <input name="name" placeholder="Full name" required>
      <input name="department" placeholder="Department / course" required>
      <input name="year" placeholder="Year / semester" required>
      <input name="roll_no" placeholder="Roll number" required>
      <input name="phone" placeholder="Phone number (optional)">
      <button class="button primary">Submit registration</button>
      <p class="status" id="regStatus"></p>
    </form>
  </div>`;
  document.body.appendChild(form);
  $("#regForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(ev.target));
    try {
      await api(`/api/events/${id}/register`, {method:"POST", body:JSON.stringify(data)});
      $("#regStatus").textContent = "Registration submitted successfully.";
      ev.target.reset();
    } catch(err) { $("#regStatus").textContent = err.message; }
  };
};

$("#search").addEventListener("input", () => renderEvents(events.filter(e => e.date >= new Date().toISOString().slice(0,10))));

$("#feedbackForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/api/feedback",{method:"POST",body:JSON.stringify({
      kind: $("#feedbackKind").value, message: $("#feedbackMessage").value
    })});
    $("#feedbackStatus").textContent = "Submitted anonymously. Thank you.";
    $("#feedbackMessage").value = "";
  } catch(err) { $("#feedbackStatus").textContent = err.message; }
};

function openStaffModal(){ $("#staffModal").classList.remove("hidden"); $("#staffPassword").focus(); }
$("#staffOpen").onclick = openStaffModal;
$("#staffClose").onclick = () => $("#staffModal").classList.add("hidden");

$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/api/login",{method:"POST",body:JSON.stringify({password:$("#staffPassword").value})});
    staff = true;
    $("#staffModal").classList.add("hidden");
    $("#staffPanel").classList.remove("hidden");
    location.hash = "staffPanel";
    await loadEvents(); await loadRegistrations(); await loadFeedback();
  } catch(err) { $("#loginStatus").textContent = err.message; }
};

$("#logout").onclick = async () => {
  await api("/api/logout",{method:"POST"});
  staff=false; $("#staffPanel").classList.add("hidden"); location.hash="home";
};

function renderAdminEvents(list) {
  $("#adminEvents").innerHTML = list.length ? list.map(e => `
    <div class="feedback-item">
      <strong>${esc(e.title)}</strong><br>
      <small>${esc(formatDate(e.date))} · ${esc(e.venue || "Venue TBA")} · Registration: ${e.registration_enabled ? "OPEN" : "CLOSED"}</small>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button class="small-btn" onclick="editEvent(${e.id})">Edit</button>
        <button class="small-btn" onclick="deleteEvent(${e.id})">Delete</button>
      </div>
    </div>`).join("") : "<p class='muted'>No events.</p>";
}

window.editEvent = (id) => {
  const e = events.find(x=>x.id===id); if(!e) return;
  $("#eventId").value=e.id; $("#eventTitle").value=e.title; $("#eventType").value=e.type;
  $("#eventDescription").value=e.description; $("#eventDate").value=e.date; $("#eventTime").value=e.time;
  $("#eventVenue").value=e.venue; $("#registrationEnabled").checked=!!e.registration_enabled;
  $("#eventFormTitle").textContent="Edit event"; $("#cancelEdit").classList.remove("hidden");
  window.scrollTo({top:document.querySelector(".staff-panel").offsetTop,behavior:"smooth"});
};
window.deleteEvent = async (id) => {
  if (!confirm("Delete this event? Existing registrations will also be removed.")) return;
  try { await api(`/api/events/${id}`,{method:"DELETE"}); await loadEvents(); } catch(err){ alert(err.message); }
};

$("#cancelEdit").onclick = () => resetEventForm();
function resetEventForm(){
  $("#eventForm").reset(); $("#eventId").value=""; $("#eventFormTitle").textContent="Add event"; $("#cancelEdit").classList.add("hidden");
}
$("#eventForm").onsubmit = async (e) => {
  e.preventDefault();
  const id=$("#eventId").value;
  const data={
    title:$("#eventTitle").value,type:$("#eventType").value,description:$("#eventDescription").value,
    date:$("#eventDate").value,time:$("#eventTime").value,venue:$("#eventVenue").value,
    registration_enabled:$("#registrationEnabled").checked
  };
  try {
    await api(id?`/api/events/${id}`:"/api/events",{method:id?"PUT":"POST",body:JSON.stringify(data)});
    $("#eventStatus").textContent="Saved."; resetEventForm(); await loadEvents();
  } catch(err){ $("#eventStatus").textContent=err.message; }
};

async function loadRegistrations(){
  const rows=await api("/api/registrations");
  $("#registrationsBody").innerHTML=rows.length ? rows.map(r=>`
    <tr><td>${esc(r.event_title)}</td><td>${esc(r.name)}</td><td>${esc(r.department)}</td><td>${esc(r.year)}</td><td>${esc(r.roll_no)}</td><td>${esc(r.phone)}</td><td><button class="small-btn" onclick="deleteRegistration(${r.id})">Delete</button></td></tr>
  `).join("") : `<tr><td colspan="7">No registrations yet.</td></tr>`;
}
window.deleteRegistration=async(id)=>{if(confirm("Delete this registration?")){await api(`/api/registrations/${id}`,{method:"DELETE"});loadRegistrations();}};
$("#refreshRegistrations").onclick=loadRegistrations;

async function loadFeedback(){
  const rows=await api("/api/feedback");
  $("#feedbackList").innerHTML=rows.length?rows.map(r=>`
    <div class="feedback-item"><strong>${esc(r.kind)}</strong><br><span>${esc(r.message)}</span><br><small>${esc(r.created_at)}</small>
    <button class="small-btn" style="float:right" onclick="deleteFeedback(${r.id})">Delete</button></div>`).join(""):"<p class='muted'>No messages yet.</p>";
}
window.deleteFeedback=async(id)=>{if(confirm("Delete this message?")){await api(`/api/feedback/${id}`,{method:"DELETE"});loadFeedback();}};
$("#refreshFeedback").onclick=loadFeedback;

api("/api/session").then(s=>{staff=s.staff;if(staff){$("#staffPanel").classList.remove("hidden");loadEvents();loadRegistrations();loadFeedback();}});
loadEvents();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(()=>{});
