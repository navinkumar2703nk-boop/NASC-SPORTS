const isNative = typeof window !== "undefined" && window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform();
const onLocalHost = typeof location !== "undefined" && /^(http|https):\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(location.origin);
const API_BASE = isNative || !onLocalHost ? "https://nasc-sports.onrender.com" : location.origin;

const $ = (s) => document.querySelector(s);

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
      400: "Invalid request.",
      401: "Staff login required.",
      403: "Access denied.",
      404: "Not found.",
      500: "Server Error. Please try again later.",
      503: "Service Unavailable. Please try again later.",
    };
    throw new ApiError(data.error || fallback[res.status] || "Something went wrong.", res.status, data);
  }
  return data;
}

async function redirectIfAlreadyLoggedIn() {
  try {
    const s = await api("/api/session");
    if (s && s.staff) {
      location.replace("./staff-dashboard.html");
      return true;
    }
  } catch {
    // Network error - let the user try to log in anyway.
  }
  return false;
}

(async function init() {
  if (await redirectIfAlreadyLoggedIn()) return;

  $("#loginForm").onsubmit = async (e) => {
    e.preventDefault();
    const statusEl = $("#loginStatus");
    const btn = $("#loginBtn");
    statusEl.className = "status";
    statusEl.textContent = "";

    if (!$("#staffPassword").value) {
      statusEl.textContent = "Please enter the staff password.";
      statusEl.className = "status err";
      return;
    }

    btn.disabled = true;
    statusEl.textContent = "Signing in...";
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ password: $("#staffPassword").value }) });
      statusEl.textContent = "";
      location.replace("./staff-dashboard.html");
    } catch (err) {
      statusEl.textContent = err.status === 401 ? "Incorrect password." : err.message;
      statusEl.className = "status err";
    } finally {
      btn.disabled = false;
    }
  };
})();