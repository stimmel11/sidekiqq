const $ = (id) => document.getElementById(id);
const STATES = {
  idle: "Ready",
  listening: "Listening…",
  thinking: "Thinking…",
  briefing: "Preparing your brief…",
  awaiting_confirm: "Waiting for “send it” (30 s)",
  error: "Problem",
  not_paired: "Not paired",
};
let formsFilled = false;

async function call(path, payload) {
  const opts = payload === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
  return data;
}

function showError(msg) {
  const el = $("error");
  el.hidden = !msg;
  el.textContent = msg || "";
}

function render(s) {
  const st = s.settings || {};
  $("state").textContent = s.paired ? (STATES[s.state] || s.state) : (s.authFailed ? "Token rejected: pair again" : "Not paired");
  $("state").dataset.state = s.paired ? s.state : "unpaired";
  $("pair-status").textContent = s.paired ? `Paired with ${st.brain_url}` : "Ask the owner for a 6-digit pairing code (POST /api/devices/pair-code on the brain), then enter it here.";
  $("talk").disabled = !s.paired;
  $("brief").disabled = !s.paired;
  $("cancel").textContent = s.awaitingConfirm ? "Don't send" : "Cancel";
  $("wake-status").textContent = `Wake word: ${s.wakeWord}`;
  if (s.lastError && s.state === "error") showError(s.lastError);
  if (!formsFilled) {
    $("brain_url").value = st.brain_url || "";
    $("voice").value = st.voice || "alloy";
    $("speak_alerts").checked = !!st.speak_alerts;
    $("wake_word_enabled").checked = !!st.wake_word_enabled;
    $("wake_word_model").value = st.wake_word_model || "hey_jarvis";
    formsFilled = true;
  }
}

async function refresh() {
  try {
    render(await call("/sk/status"));
  } catch (e) {
    $("state").textContent = "App not responding";
  }
}

function wire(id, path) {
  $(id).addEventListener("click", async () => {
    showError("");
    try { render(await call(path, {})); } catch (e) { showError(e.message); }
  });
}
wire("talk", "/sk/talk");
wire("brief", "/sk/brief");
wire("cancel", "/sk/cancel");

$("pair-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  showError("");
  try {
    render(await call("/sk/pair", { brain_url: $("brain_url").value, code: $("code").value }));
    $("code").value = "";
  } catch (e) { showError(e.message); }
});

$("unpair").addEventListener("click", async () => {
  if (!confirm("Forget this robot's SideKiqq token?")) return;
  try { render(await call("/sk/unpair", {})); } catch (e) { showError(e.message); }
});

$("settings-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  showError("");
  try {
    render(await call("/sk/settings", {
      voice: $("voice").value,
      speak_alerts: $("speak_alerts").checked,
      wake_word_enabled: $("wake_word_enabled").checked,
      wake_word_model: $("wake_word_model").value,
    }));
  } catch (e) { showError(e.message); }
});

refresh();
setInterval(refresh, 1500);
