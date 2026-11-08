// Puente LSA — señas a texto/voz y voz a texto, 100% en el dispositivo.
// Detección de manos: MediaPipe Hand Landmarker. Reconocimiento: k-vecinos sobre
// secuencias cortas de puntos de la mano (sirve para señas quietas y con movimiento).
// La librería viene incluida en /vendor (no depende de un CDN). Se carga recién al encender la cámara,
// así la interfaz funciona aunque falle. El modelo (~7 MB) se baja la primera vez y queda guardado.
const LIB_URL = "./vendor/mediapipe/vision_bundle.mjs";
const WASM_URL = new URL("./vendor/mediapipe/wasm", location.href).href;
const MODEL_URLS = [
  "./models/hand_landmarker.task", // opcional: si lo copiás acá, funciona 100% sin internet
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
];

// ---------- Parámetros del reconocimiento ----------
const SLOT = 63;                 // por mano: presencia + posición muñeca (2) + 20 puntos × 3
const FRAME_DIM = SLOT * 2;      // dos manos
const T = 6;                     // cuadros por muestra (secuencia remuestreada)
const WIN_MS = 1000;             // ventana temporal de una seña
const PRES_W = 2.0;              // peso de "hay mano / no hay mano"
const POS_W = 4.0;               // peso de la posición de la mano en la imagen
const EVAL_MS = 100;             // cada cuánto se evalúa
const STABLE_N = 3;              // evaluaciones seguidas iguales para aceptar
const COOLDOWN_MS = 900;
const REPEAT_MS = 2500;          // misma seña repetida sin bajar las manos
const K = 3;
const DEFAULT_THR = 2.2;
const SAMPLE_GAP_MS = 1400;      // entre ejemplos al grabar

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"), video: $("video"), overlay: $("overlay"), cam: document.querySelector(".cam"),
  camOff: $("camOff"), camMsg: $("camMsg"), pred: $("pred"), btnCam: $("btnCam"), btnFlip: $("btnFlip"), btnStop: $("btnStop"),
  sentence: $("sentence"), btnUndo: $("btnUndo"), btnClear: $("btnClear"), btnSend: $("btnSend"),
  quick: $("quick"), deafForm: $("deafForm"), deafText: $("deafText"),
  live: $("live"), btnMic: $("btnMic"), btnBig: $("btnBig"), hearForm: $("hearForm"), hearText: $("hearText"),
  log: $("log"), btnClearLog: $("btnClearLog"),
  addForm: $("addForm"), newSign: $("newSign"), signList: $("signList"),
  nSamples: $("nSamples"), nSamplesVal: $("nSamplesVal"), sens: $("sens"), sensVal: $("sensVal"), autoSend: $("autoSend"), speakWords: $("speakWords"),
  btnExport: $("btnExport"), fileImport: $("fileImport"),
  bigOverlay: $("bigOverlay"), bigText: $("bigText"), btnRotate: $("btnRotate"), btnBigMic: $("btnBigMic"), btnBigClose: $("btnBigClose"),
  dialog: $("dialog"), dialogText: $("dialogText"), dialogYes: $("dialogYes"), dialogNo: $("dialogNo"), toast: $("toast"),
};

const DEFAULT_WORDS = ["Hola", "Chau", "Gracias", "Por favor", "Sí", "No", "Ayuda", "Baño", "Agua", "Dolor",
  "Médico", "Bien", "Mal", "Esperar", "Repetir", "No entiendo", "Mi nombre", "¿Dónde?", "¿Cuánto?", "Trabajo"];
const QUICK_PHRASES = ["Hola", "Gracias", "Soy sordo/a", "No entiendo", "¿Podés repetir?", "Escribilo, por favor",
  "Hablá más despacio", "Esperá un momento", "Necesito ayuda", "Sí", "No", "Chau"];

// ---------- Estado ----------
const state = {
  signs: [],            // {id, label, samples: [number[]]}
  thresholds: new Map(),// id -> umbral
  settings: { nSamples: 10, sens: 1, autoSend: true, speakWords: true },
  sentence: [],
  log: [],
  landmarker: null, stream: null, facing: "user", running: false,
  buffer: [], lastVideoTime: -1, lastEval: 0,
  stable: { id: null, n: 0 }, lastEmitted: null, lastEmitTime: 0, lastWordTime: 0,
  rec: null, // grabación en curso {signId, remaining, nextAt, phase}
};

// ---------- Utilidades ----------
let toastTimer;
function toast(msg, ms = 2600) {
  els.toast.textContent = msg; els.toast.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => els.toast.classList.add("hidden"), ms);
}
function confirmBox(text) {
  return new Promise((resolve) => {
    els.dialogText.textContent = text; els.dialog.classList.remove("hidden");
    const done = (v) => { els.dialog.classList.add("hidden"); els.dialogYes.onclick = els.dialogNo.onclick = null; resolve(v); };
    els.dialogYes.onclick = () => done(true); els.dialogNo.onclick = () => done(false);
  });
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function setStatus(t) { els.status.textContent = t; }

// ---------- Almacenamiento (IndexedDB con respaldo en memoria) ----------
const store = {
  db: null,
  async open() {
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open("puente-lsa", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    } catch (e) { console.warn("Sin IndexedDB", e); this.db = null; }
  },
  get(key) {
    if (!this.db) return Promise.resolve(undefined);
    return new Promise((res) => {
      try { const r = this.db.transaction("kv").objectStore("kv").get(key); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); }
      catch { res(undefined); }
    });
  },
  set(key, val) {
    if (!this.db) return Promise.resolve();
    return new Promise((res) => {
      try { const tx = this.db.transaction("kv", "readwrite"); tx.objectStore("kv").put(val, key); tx.oncomplete = res; tx.onerror = res; }
      catch { res(); }
    });
  },
};
let saveTimer;
function saveSigns() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set("signs", state.signs), 300); }
function saveSettings() { store.set("settings", state.settings); }

// ---------- Características de la mano ----------
// Devuelve un vector por cuadro con las dos manos normalizadas (posición relativa a la muñeca,
// escala por tamaño de la mano) más la posición de la muñeca en la imagen.
export function frameFeatures(landmarks, handedness, aspect, mirrorFix) {
  const f = new Float32Array(FRAME_DIM);
  let present = 0;
  const used = [false, false];
  for (let i = 0; i < (landmarks || []).length; i++) {
    const lm = landmarks[i];
    let name = handedness?.[i]?.[0]?.categoryName || "Right";
    if (mirrorFix) name = name === "Left" ? "Right" : "Left";
    let slot = name === "Left" ? 0 : 1;
    if (used[slot]) slot = 1 - slot;
    if (used[slot]) continue;
    used[slot] = true;
    const gx = (p) => (mirrorFix ? 1 - p.x : p.x);
    const w = lm[0], m = lm[9];
    const scale = Math.hypot((gx(m) - gx(w)) * aspect, m.y - w.y) || 1e-3;
    const o = slot * SLOT;
    f[o] = PRES_W;
    f[o + 1] = (gx(w) - 0.5) * POS_W;
    f[o + 2] = (w.y - 0.5) * POS_W;
    for (let j = 1; j < 21; j++) {
      const p = lm[j], k = o + 3 + (j - 1) * 3;
      f[k] = ((gx(p) - gx(w)) * aspect) / scale;
      f[k + 1] = (p.y - w.y) / scale;
      f[k + 2] = ((p.z - w.z) / scale) * 0.5;
    }
    present++;
  }
  return { f, present };
}

// Toma los cuadros del último segundo y los remuestrea a T cuadros.
export function windowVector(buffer, now) {
  const start = now - WIN_MS;
  const frames = buffer.filter((b) => b.t >= start);
  if (frames.length < 4) return null;
  const withHands = frames.filter((b) => b.present > 0).length;
  const ratio = withHands / frames.length;
  const vec = new Float32Array(T * FRAME_DIM);
  let j = 0;
  for (let i = 0; i < T; i++) {
    const target = start + ((i + 0.5) * WIN_MS) / T;
    while (j < frames.length - 1 && Math.abs(frames[j + 1].t - target) <= Math.abs(frames[j].t - target)) j++;
    vec.set(frames[j].f, i * FRAME_DIM);
  }
  return { vec, ratio };
}

export function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s / T);
}

// Umbral por seña: mediana de la distancia al vecino más cercano entre sus propios ejemplos.
export function computeThresholds(signs) {
  const th = new Map();
  for (const s of signs) {
    const n = s.samples.length;
    if (n < 2) { th.set(s.id, DEFAULT_THR); continue; }
    const nn = [];
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (let k = 0; k < n; k++) if (k !== i) best = Math.min(best, dist(s.samples[i], s.samples[k]));
      nn.push(best);
    }
    nn.sort((a, b) => a - b);
    const med = nn[Math.floor(nn.length / 2)];
    th.set(s.id, Math.min(Math.max(med * 2.2, 0.8), 4));
  }
  return th;
}

export function classify(vec, signs, thresholds, sens = 1) {
  const all = [];
  for (const s of signs) for (const smp of s.samples) all.push({ id: s.id, d: dist(vec, smp) });
  if (!all.length) return null;
  all.sort((a, b) => a.d - b.d);
  const top = all.slice(0, K);
  const votes = new Map();
  for (const t of top) votes.set(t.id, (votes.get(t.id) || 0) + 1 / (t.d + 1e-3));
  let bestId = null, bestV = -1;
  for (const [id, v] of votes) if (v > bestV) { bestV = v; bestId = id; }
  const d1 = Math.min(...all.filter((a) => a.id === bestId).map((a) => a.d));
  const other = all.find((a) => a.id !== bestId);
  const thr = (thresholds.get(bestId) ?? DEFAULT_THR) * sens;
  const margin = other ? d1 / other.d : 0;
  const ok = d1 <= thr && margin < 0.92;
  return { id: bestId, d: d1, thr, ok, margin };
}

// ---------- Cámara y detección ----------
async function initLandmarker() {
  setStatus("Cargando modelo de manos…");
  const { HandLandmarker, FilesetResolver } = await import(LIB_URL);
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const opts = (model, delegate) => ({ baseOptions: { modelAssetPath: model, delegate }, runningMode: "VIDEO", numHands: 2,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
  let lastErr;
  for (const model of MODEL_URLS) {
    try { const r = await fetch(model, { method: "HEAD" }); if (!r.ok && r.type !== "opaque") continue; } catch { /* probamos igual */ }
    for (const delegate of ["GPU", "CPU"]) {
      try { state.landmarker = await HandLandmarker.createFromOptions(fileset, opts(model, delegate)); return; }
      catch (e) { lastErr = e; console.warn(`Modelo ${model} con ${delegate} falló`, e); }
    }
  }
  throw new Error("no se pudo cargar el modelo de manos (¿hay internet la primera vez?) " + (lastErr?.message || ""));
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { toast("Este navegador no permite usar la cámara. Abrí la app con https://"); return; }
  els.btnCam.disabled = true;
  try {
    if (!state.landmarker) await initLandmarker();
    stopCamera(true);
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facing, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    els.video.srcObject = state.stream;
    await els.video.play();
    els.cam.classList.toggle("mirror", state.facing === "user");
    els.camOff.classList.add("hidden");
    state.running = true; state.buffer = []; state.lastVideoTime = -1;
    const token = ++loopToken;
    setStatus(state.signs.some((s) => s.samples.length) ? "Listo para señar" : "Entrená señas para empezar");
    requestAnimationFrame(() => loop(token));
  } catch (e) {
    console.error(e);
    toast(e.name === "NotAllowedError" ? "Necesito permiso para usar la cámara." : "No pude iniciar la cámara: " + e.message, 4000);
    setStatus("Cámara apagada");
  } finally { els.btnCam.disabled = false; }
}

function stopCamera(silent) {
  state.running = false;
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null; els.video.srcObject = null;
  if (!silent) { els.camOff.classList.remove("hidden"); els.pred.classList.add("hidden"); setStatus("Cámara apagada"); cancelRecording(); }
}

const ctx = els.overlay.getContext("2d");
const CONN = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
function draw(landmarks) {
  const W = els.video.videoWidth, H = els.video.videoHeight;
  if (els.overlay.width !== W) { els.overlay.width = W; els.overlay.height = H; }
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = Math.max(2, W / 200);
  for (const lm of landmarks || []) {
    ctx.strokeStyle = "#14b8a6";
    ctx.beginPath();
    for (const [a, b] of CONN) { ctx.moveTo(lm[a].x * W, lm[a].y * H); ctx.lineTo(lm[b].x * W, lm[b].y * H); }
    ctx.stroke();
    ctx.fillStyle = "#fff";
    for (const p of lm) { ctx.beginPath(); ctx.arc(p.x * W, p.y * H, ctx.lineWidth * 1.3, 0, 6.29); ctx.fill(); }
  }
}

let loopToken = 0;
function loop(token) {
  if (!state.running || token !== loopToken) return;
  const v = els.video;
  if (v.readyState >= 2 && v.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = v.currentTime;
    const now = performance.now();
    let res;
    try { res = state.landmarker.detectForVideo(v, now); } catch (e) { console.warn(e); }
    if (res) {
      draw(res.landmarks);
      const aspect = (v.videoWidth || 4) / (v.videoHeight || 3);
      const { f, present } = frameFeatures(res.landmarks, res.handedness || res.handednesses, aspect, state.facing !== "user");
      state.buffer.push({ t: now, f, present });
      while (state.buffer.length && state.buffer[0].t < now - WIN_MS - 300) state.buffer.shift();
      if (state.rec) recordingTick(now);
      else if (now - state.lastEval > EVAL_MS) { state.lastEval = now; recognize(now); }
    }
  }
  requestAnimationFrame(() => loop(token));
}

function signById(id) { return state.signs.find((s) => s.id === id); }

function recognize(now) {
  const trained = state.signs.filter((s) => s.samples.length);
  if (!trained.length) { els.pred.classList.add("hidden"); return; }
  maybeAutoSend(now);
  const w = windowVector(state.buffer, now);
  if (!w || w.ratio < 0.6) {
    if (!w || w.ratio < 0.2) state.lastEmitted = null; // bajó las manos: permite repetir
    state.stable = { id: null, n: 0 };
    els.pred.classList.add("hidden");
    return;
  }
  const p = classify(w.vec, trained, state.thresholds, state.settings.sens);
  if (p && p.ok) {
    const label = signById(p.id)?.label;
    els.pred.textContent = "✋ " + label; els.pred.classList.remove("hidden");
    state.stable = state.stable.id === p.id ? { id: p.id, n: state.stable.n + 1 } : { id: p.id, n: 1 };
    const repeatOk = p.id !== state.lastEmitted || now - state.lastEmitTime > REPEAT_MS;
    if (state.stable.n >= STABLE_N && repeatOk && now - state.lastEmitTime > COOLDOWN_MS) {
      addWord(label);
      state.lastEmitted = p.id; state.lastEmitTime = now; state.stable = { id: null, n: 0 };
      if (navigator.vibrate) try { navigator.vibrate(40); } catch {}
    }
  } else {
    els.pred.textContent = "…"; els.pred.classList.remove("hidden");
    state.stable = { id: null, n: 0 };
  }
}

// ---------- Frase de la persona sorda ----------
function renderSentence(animateLast) {
  if (!state.sentence.length) { els.sentence.innerHTML = '<span class="ph">Las señas reconocidas aparecen acá…</span>'; return; }
  els.sentence.innerHTML = state.sentence.map((w, i) =>
    `<span class="word"${animateLast && i === state.sentence.length - 1 ? "" : ' style="animation:none"'}>${esc(w)}</span>`).join("");
}
function addWord(w) {
  state.sentence.push(w); state.lastWordTime = performance.now(); renderSentence(true);
  if (state.settings.speakWords) speak(w, true); // se escucha apenas se reconoce
}
const PAUSE_MS = 2000;
function maybeAutoSend(now) {
  if (state.settings.autoSend && state.sentence.length && now - state.lastWordTime > PAUSE_MS) {
    // si cada palabra ya se dijo, la frase solo pasa a la conversación (no se repite en voz alta)
    sendSentence(state.settings.speakWords);
  }
}
function sendSentence(silent) {
  const text = state.sentence.join(" ").trim();
  if (!text) { toast("Todavía no hay una frase para decir."); return; }
  if (silent !== true) speak(text);
  addLog("deaf", text);
  state.sentence = []; renderSentence();
}

// ---------- Voz (lectura en voz alta) ----------
let voice = null;
function pickVoice() {
  const vs = speechSynthesis?.getVoices?.() || [];
  voice = vs.find((v) => v.lang === "es-AR") || vs.find((v) => v.lang?.startsWith("es-US")) ||
          vs.find((v) => v.lang?.startsWith("es-419")) || vs.find((v) => v.lang?.startsWith("es")) || null;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
// iPhone y algunos Android no dejan hablar hasta un primer toque: "despertamos" la voz en silencio.
let speechUnlocked = false;
function unlockSpeech() {
  if (speechUnlocked || !("speechSynthesis" in window)) return;
  speechUnlocked = true;
  try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } catch {}
}
document.addEventListener("pointerdown", unlockSpeech, { once: true, capture: true });
function speak(text, queue) {
  if (!("speechSynthesis" in window)) { toast("Este dispositivo no puede leer en voz alta."); return; }
  try {
    if (!voice) pickVoice();
    if (!queue) speechSynthesis.cancel();
    if (speechSynthesis.paused) speechSynthesis.resume();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice?.lang || "es-AR"; if (voice) u.voice = voice; u.rate = 1;
    speechSynthesis.speak(u);
  } catch (e) { console.warn(e); }
}

// ---------- Dictado de la persona oyente ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = { rec: null, on: false, finalText: "" };
function setLive(finalText, interim) {
  const html = (finalText ? esc(finalText) : "") + (interim ? ` <span class="interim">${esc(interim)}</span>` : "");
  els.live.innerHTML = html.trim() ? html : '<span class="ph">Tocá el micrófono y hablá…</span>';
  if (!els.bigOverlay.classList.contains("hidden")) els.bigText.textContent = (finalText + " " + (interim || "")).trim() || "…";
}
function startMic() {
  if (!SR) { toast("El dictado no está disponible en este navegador. Usá el micrófono del teclado o escribí.", 4500); els.hearText.focus(); return; }
  speechSynthesis?.cancel?.();
  mic.finalText = ""; mic.on = true;
  const rec = new SR();
  rec.lang = "es-AR"; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) mic.finalText = (mic.finalText + " " + r[0].transcript).trim();
      else interim += r[0].transcript;
    }
    setLive(mic.finalText, interim);
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") { toast("Necesito permiso para usar el micrófono."); stopMic(); }
    else if (e.error !== "no-speech" && e.error !== "aborted") console.warn("SR", e.error);
  };
  rec.onend = () => { if (mic.on) { try { rec.start(); } catch { stopMic(); } } };
  try { rec.start(); } catch (e) { toast("No pude iniciar el micrófono."); mic.on = false; return; }
  mic.rec = rec; setLive("", "");
  [els.btnMic, els.btnBigMic].forEach((b) => { b.classList.add("listening"); b.textContent = "⏹ Terminar"; });
}
function stopMic() {
  mic.on = false;
  try { mic.rec?.stop(); } catch {}
  mic.rec = null;
  [els.btnMic, els.btnBigMic].forEach((b) => { b.classList.remove("listening"); b.textContent = "🎤 Hablar"; });
  if (mic.finalText.trim()) { addLog("hearing", mic.finalText.trim()); showHearing(mic.finalText.trim()); }
  mic.finalText = "";
}
function toggleMic() { mic.on ? stopMic() : startMic(); }
function showHearing(text) {
  els.live.textContent = text;
  if (!els.bigOverlay.classList.contains("hidden")) els.bigText.textContent = text;
}

// ---------- Registro de conversación ----------
function addLog(who, text) {
  state.log.push({ who, text, t: Date.now() });
  renderLog(); store.set("log", state.log.slice(-200));
}
function renderLog() {
  if (!state.log.length) { els.log.innerHTML = '<p class="ph">Todavía no hay mensajes.</p>'; return; }
  els.log.innerHTML = state.log.map((m) => {
    const time = new Date(m.t).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
    return `<div class="msg ${m.who}"><small>${m.who === "deaf" ? "🤟 Persona sorda" : "🗣️ Persona oyente"} · ${time}</small>${esc(m.text)}</div>`;
  }).join("");
  els.log.scrollTop = els.log.scrollHeight;
}

// ---------- Entrenamiento ----------
function renderSigns() {
  if (!state.signs.length) { els.signList.innerHTML = '<p class="ph">No hay señas. Agregá una palabra arriba.</p>'; return; }
  els.signList.innerHTML = state.signs.map((s) => {
    const n = s.samples.length;
    const cls = n >= 8 ? "ok" : n > 0 ? "low" : "";
    const rec = state.rec?.signId === s.id;
    return `<div class="sign${rec ? " recording" : ""}" data-id="${s.id}">
      <span class="name">${esc(s.label)}</span>
      <span class="badge ${cls}">${n} ej.</span>
      <button class="btn small primary" data-act="rec">${rec ? "⏹ Parar" : "⏺ Grabar"}</button>
      <button class="btn small" data-act="test" title="Probar">▶</button>
      <button class="btn small" data-act="del" title="Eliminar">🗑</button>
    </div>`;
  }).join("");
}

function startRecording(id) {
  if (!state.running) { toast("Primero iniciá la cámara (arriba)."); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
  state.rec = { signId: id, remaining: state.settings.nSamples, nextAt: performance.now() + 3000, phase: "countdown" };
  renderSigns(); window.scrollTo({ top: 0, behavior: "smooth" });
}
function cancelRecording() {
  if (!state.rec) return;
  state.rec = null; els.camMsg.classList.add("hidden"); renderSigns();
  state.thresholds = computeThresholds(state.signs); saveSigns();
}
function recordingTick(now) {
  const r = state.rec, s = signById(r.signId);
  if (!s) { cancelRecording(); return; }
  els.camMsg.classList.remove("hidden");
  const left = r.nextAt - now;
  if (r.phase === "countdown") {
    els.camMsg.classList.remove("go");
    els.camMsg.textContent = left > 0 ? `“${s.label}” en ${Math.ceil(left / 1000)}…` : "";
    if (left <= 0) { r.phase = "capture"; r.nextAt = now + WIN_MS; }
    return;
  }
  // fase de captura: el usuario hace la seña durante WIN_MS
  els.camMsg.classList.add("go");
  els.camMsg.textContent = `¡Ahora! ${s.label}  (${state.settings.nSamples - r.remaining + 1}/${state.settings.nSamples})`;
  if (left <= 0) {
    const w = windowVector(state.buffer, now);
    if (w && w.ratio >= 0.5) {
      s.samples.push(Array.from(w.vec, (x) => Math.round(x * 1000) / 1000));
      r.remaining--;
      if (navigator.vibrate) try { navigator.vibrate(30); } catch {}
      renderSigns();
    } else toast("No vi las manos, repetimos ese ejemplo.", 1500);
    if (r.remaining <= 0) { cancelRecording(); toast(`Listo: “${s.label}” tiene ${s.samples.length} ejemplos.`); return; }
    r.phase = "countdown"; r.nextAt = now + SAMPLE_GAP_MS - WIN_MS + 400;
  }
}

function addSign(label) {
  label = label.trim();
  if (!label) return null;
  const existing = state.signs.find((s) => s.label.toLowerCase() === label.toLowerCase());
  if (existing) return existing;
  const s = { id: uid(), label, samples: [] };
  state.signs.push(s); saveSigns(); renderSigns();
  return s;
}

// ---------- Exportar / importar ----------
function exportData() {
  const data = JSON.stringify({ app: "puente-lsa", version: 1, frameDim: FRAME_DIM, T, signs: state.signs });
  const blob = new Blob([data], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `senas-puente-lsa-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "puente-lsa" || data.frameDim !== FRAME_DIM || data.T !== T) throw new Error("archivo no compatible");
    let added = 0;
    for (const s of data.signs || []) {
      const target = addSign(s.label);
      for (const smp of s.samples || []) if (smp.length === T * FRAME_DIM) { target.samples.push(smp); added++; }
    }
    state.thresholds = computeThresholds(state.signs); saveSigns(); renderSigns();
    toast(`Importados ${added} ejemplos.`);
  } catch (e) { toast("No pude importar: " + e.message, 4000); }
}

// ---------- Interfaz ----------
function sensLabel(v) { return v <= 0.8 ? "Estricto" : v >= 1.3 ? "Flexible" : "Normal"; }
function bindUI() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    const v = t.dataset.view;
    ["talk", "train", "help"].forEach((n) => $("view-" + n).classList.toggle("hidden", n !== v));
    $("camCard").classList.toggle("hidden", v === "help");
    if (v !== "train") cancelRecording();
  }));
  els.btnCam.onclick = startCamera;
  els.btnStop.onclick = () => stopCamera(false);
  els.btnFlip.onclick = () => { state.facing = state.facing === "user" ? "environment" : "user"; if (state.running) startCamera(); else toast(state.facing === "user" ? "Cámara frontal" : "Cámara trasera"); };
  els.btnUndo.onclick = () => { state.sentence.pop(); renderSentence(); };
  els.btnClear.onclick = () => { state.sentence = []; renderSentence(); };
  els.btnSend.onclick = () => sendSentence(false);
  els.quick.innerHTML = QUICK_PHRASES.map((p) => `<button class="btn" type="button">${esc(p)}</button>`).join("");
  els.quick.onclick = (e) => { const b = e.target.closest("button"); if (b) { speak(b.textContent); addLog("deaf", b.textContent); } };
  els.deafForm.onsubmit = (e) => { e.preventDefault(); const t = els.deafText.value.trim(); if (t) { speak(t); addLog("deaf", t); els.deafText.value = ""; } };
  els.btnMic.onclick = toggleMic; els.btnBigMic.onclick = toggleMic;
  els.hearForm.onsubmit = (e) => { e.preventDefault(); const t = els.hearText.value.trim(); if (t) { addLog("hearing", t); showHearing(t); els.hearText.value = ""; els.hearText.blur(); } };
  els.btnBig.onclick = () => {
    const last = [...state.log].reverse().find((m) => m.who === "hearing");
    els.bigText.textContent = els.live.textContent.trim() && !els.live.querySelector(".ph") ? els.live.textContent : (last?.text || "…");
    els.bigOverlay.classList.remove("hidden");
  };
  els.btnBigClose.onclick = () => els.bigOverlay.classList.add("hidden");
  els.btnRotate.onclick = () => els.bigText.classList.toggle("rot");
  els.btnClearLog.onclick = async () => { if (await confirmBox("¿Borrar toda la conversación?")) { state.log = []; renderLog(); store.set("log", []); } };

  els.addForm.onsubmit = (e) => { e.preventDefault(); const s = addSign(els.newSign.value); els.newSign.value = ""; if (s) toast(`“${s.label}” agregada. Tocá Grabar.`); };
  els.signList.onclick = async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const id = b.closest(".sign").dataset.id, s = signById(id);
    if (b.dataset.act === "rec") { state.rec?.signId === id ? cancelRecording() : (cancelRecording(), startRecording(id)); }
    else if (b.dataset.act === "del") {
      if (await confirmBox(`¿Eliminar “${s.label}” y sus ${s.samples.length} ejemplos?`)) {
        if (state.rec?.signId === id) cancelRecording();
        state.signs = state.signs.filter((x) => x.id !== id); state.thresholds = computeThresholds(state.signs); saveSigns(); renderSigns();
      }
    } else if (b.dataset.act === "test") {
      speak(s.label); document.querySelector('.tab[data-view="talk"]').click(); toast(`Hacé la seña “${s.label}” para probarla.`);
    }
  };
  els.nSamples.oninput = () => { state.settings.nSamples = +els.nSamples.value; els.nSamplesVal.textContent = els.nSamples.value; saveSettings(); };
  els.sens.oninput = () => { state.settings.sens = +els.sens.value; els.sensVal.textContent = sensLabel(state.settings.sens); saveSettings(); };
  els.autoSend.onchange = () => { state.settings.autoSend = els.autoSend.checked; saveSettings(); };
  els.speakWords.onchange = () => { state.settings.speakWords = els.speakWords.checked; saveSettings(); };
  els.btnExport.onclick = exportData;
  els.fileImport.onchange = () => { const f = els.fileImport.files[0]; if (f) importData(f); els.fileImport.value = ""; };
  document.addEventListener("visibilitychange", () => { if (document.hidden && mic.on) stopMic(); });
}

async function init() {
  bindUI();
  await store.open();
  const saved = await store.get("signs");
  state.signs = Array.isArray(saved) ? saved : DEFAULT_WORDS.map((label) => ({ id: uid(), label, samples: [] }));
  if (!Array.isArray(saved)) saveSigns();
  const st = await store.get("settings"); if (st) Object.assign(state.settings, st);
  state.log = (await store.get("log")) || [];
  els.nSamples.value = state.settings.nSamples; els.nSamplesVal.textContent = state.settings.nSamples;
  els.sens.value = state.settings.sens; els.sensVal.textContent = sensLabel(state.settings.sens);
  els.autoSend.checked = state.settings.autoSend;
  els.speakWords.checked = state.settings.speakWords;
  state.thresholds = computeThresholds(state.signs);
  renderSigns(); renderLog(); renderSentence();
  setStatus("Cámara apagada");
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
}
init();
