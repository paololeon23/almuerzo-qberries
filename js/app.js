import { APP_VERSION, APP_ASSETS, FORM_TYPES, TZ, encodeQr, parseQr, normalizeDni, isSesionDni, todayKey, uuid, nowParts } from "./config.js";
import { bindAppHeight, bindFieldLock, isFieldDevice, preventBounce } from "./device.js";
import { recordsOfToday, store } from "./store.js";
import { onVoiceState, setVoiceEnabled, speak, speakApellido, unlockVoice, voiceEnabled } from "./voice.js";
import { computeHeadcount } from "./calc.js";
import { checkTurno, flushQueue, pingServer, saveAndSync } from "./sync.js";
import { FieldScanner } from "./scanner.js";

const scanner = new FieldScanner();
let deferredInstall = null;

function markInstalled() {
  store.setPrefs({ installed: true });
}

function hideInstallSlot() {
  const host = document.getElementById("install-slot");
  if (host) host.hidden = true;
}

function isAppInstalled() {
  if (window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: fullscreen)").matches) {
    markInstalled();
    return true;
  }
  if (window.navigator.standalone === true) {
    markInstalled();
    return true;
  }
  return store.getPrefs().installed === true;
}

function bindInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    if (isAppInstalled()) hideInstallSlot();
  });
  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    markInstalled();
    hideInstallSlot();
  });
}

function installSlot() {
  if (isAppInstalled()) return "";
  return `<div id="install-slot">
    <button class="install-cta" data-act="install-app" type="button">
      <img src="./icons/icon-192.png" alt="" />
      Instalar en inicio
    </button>
  </div>`;
}

async function installApp() {
  if (isAppInstalled()) {
    hideInstallSlot();
    return;
  }
  if (deferredInstall) {
    deferredInstall.prompt();
    const choice = await deferredInstall.userChoice;
    deferredInstall = null;
    if (choice?.outcome === "accepted") {
      markInstalled();
      hideInstallSlot();
    }
    return;
  }
  const ios = /iPhone|iPod/i.test(navigator.userAgent || "");
  if (ios) {
    openAlert(`<div class="modal-back" data-act="dismiss-alert">
      <div class="modal" role="dialog" aria-modal="true">
        <img class="install-ico" src="./icons/icon-192.png" alt="" />
        <h3>Solicitud de almuerzo</h3>
        <p>En Safari: toque Compartir y luego Agregar a pantalla de inicio. El nombre es Solicitud de almuerzo.</p>
        <button class="btn" data-act="dismiss-alert" type="button">Entendido</button>
      </div>
    </div>`);
    return;
  }
  showAlert("Instalar", "En el menú del navegador elija Instalar app o Agregar a pantalla de inicio. El nombre es Solicitud de almuerzo.");
}
const state = {
  view: "boot",
  tab: "home",
  cfg: null,
  menu: null,
  items: [],
  workers: [],
  oficial: new Map(),
  supByDni: new Map(),
  wrkByDni: new Map(),
  workersPromise: null,
  supervisors: [],
  scanQueue: [],
  scanMode: "sup",
  draft: emptyDraft(),
  formType: "pedido",
  lastSpeak: "",
  online: navigator.onLine,
  busy: false,
  loggingIn: false,
  emergencyPending: false,
  extraOn: false,
  admin: false,
  logoTaps: 0,
  mesaPage: 1,
  dniPage: 1,
  dniQuery: "",
  dniSelected: {},
  histPage: 1,
  histOpen: "",
  histPeoplePage: 1,
  histPeopleQuery: "",
  lotes: [],
  swGuardUntil: 0,
};

function emptyDraft(worker = null) {
  return {
    worker,
    cantidades: {},
    comentario: "",
    tipo_dieta: "",
    alergias: "",
    clientId: uuid(),
  };
}

function freshFetch() {
  try {
    return sessionStorage.getItem("qb_updating") ? "reload" : "default";
  } catch {
    return "default";
  }
}

async function loadJson(path, fallback) {
  try {
    const res = await fetch(path, { cache: freshFetch() });
    return await res.json();
  } catch {
    return fallback;
  }
}

function nameParts(person) {
  const full = String(person?.nombreCompleto || [person?.apellido, person?.nombre].filter(Boolean).join(" ") || person?.nombre || "")
    .replace(/\s+/g, " ")
    .trim();
  const parts = full.split(" ").filter(Boolean);
  const apellido = parts.length >= 2
    ? `${parts[0]} ${parts[1]}`.toUpperCase()
    : (parts[0] || person?.apellido || "").toUpperCase();
  const nombre = parts.slice(parts.length >= 2 ? 2 : 1).join(" ");
  return { apellido, nombre, nombreCompleto: full };
}

function twoApellidos(person) {
  return nameParts(person).apellido;
}

function supervisorNombreCompleto(s) {
  if (!s) return "";
  const full = nameParts(s).nombreCompleto || [s.apellido, s.nombre].filter(Boolean).join(" ");
  return String(full || s.apellido || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function mapTrabajador(row) {
  const dni = normalizeDni(row.dni || row.id);
  const parsed = nameParts({ nombreCompleto: row.nombre, apellido: row.apellido, nombre: row.nombre });
  return {
    id: dni,
    dni,
    apellido: parsed.apellido,
    nombre: parsed.nombre,
    nombreCompleto: parsed.nombreCompleto || String(row.nombre || "").trim(),
    cargo: row.cargo || "",
    area: row.cargo || row.area || "",
  };
}

function mergePeople(fileList, localList) {
  const map = new Map();
  for (const p of fileList || []) {
    const row = p.dni && !p.apellido ? mapTrabajador(p) : p;
    const key = normalizeDni(row.dni || row.id);
    if (key) map.set(key, { ...row, id: key, dni: key });
  }
  for (const p of localList || []) {
    const key = normalizeDni(p.dni || p.id);
    if (key) map.set(key, { ...map.get(key), ...p, id: key, dni: key });
  }
  return [...map.values()];
}

function findWorkerByDni(dni) {
  const key = normalizeDni(dni);
  if (!key) return null;
  return state.wrkByDni.get(key) || state.supByDni.get(key) || null;
}

function findOfficial(dni) {
  return findWorkerByDni(dni);
}

async function loadTrabajadores() {
  const raw = await loadJson("./data/trabajadores.json", []);
  const list = Array.isArray(raw) ? raw : (raw.trabajadores || []);
  const map = new Map();
  for (const row of list) {
    const person = mapTrabajador(row);
    if (person.dni) map.set(person.dni, person);
  }
  state.wrkByDni = map;
  state.workers = [...map.values()];
  state.oficial = map;
}

function ensureWorkers() {
  if (state.wrkByDni.size) return Promise.resolve();
  if (!state.workersPromise) state.workersPromise = loadTrabajadores();
  return state.workersPromise;
}

function personFromSaved(dni) {
  const official = findOfficial(dni);
  if (official) return official;
  const key = normalizeDni(dni);
  const p = store.getDniGuardados().find((x) => normalizeDni(x.id || x.dni) === key);
  if (!p) return null;
  return {
    dni: p.dni || p.id,
    id: p.dni || p.id,
    apellido: p.apellido,
    nombre: p.nombre,
    nombreCompleto: [p.apellido, p.nombre].filter(Boolean).join(" "),
    cargo: p.cargo || "Temporal",
    temporal: true,
  };
}

function findPerson(parsed) {
  if (!parsed) return null;
  return findOfficial(parsed.dni || parsed.id);
}

function findWorker(parsed) {
  return findPerson(parsed);
}

function findSupervisor(parsed) {
  const dni = normalizeDni(parsed?.dni || parsed?.id);
  if (!dni) return null;
  return state.supByDni.get(dni) || null;
}

function supervisor() {
  const dni = store.getSesionDni();
  if (!dni) return null;
  const hit = state.supByDni.get(dni);
  if (hit) return { ...hit, apellido: twoApellidos(hit) };
  const ses = store.getSesion();
  if (ses?.emergencia) {
    return {
      id: dni,
      dni,
      apellido: ses.apellido || "",
      nombre: ses.nombre || "",
      cargo: "Supervisor de emergencia",
      emergencia: true,
    };
  }
  if (!state.supByDni.size) {
    return { id: dni, dni, apellido: "", nombre: "", cargo: "" };
  }
  store.clearSesion();
  return null;
}

function expectedHeadcount() {
  return Number(store.getPrefs().headcount || state.cfg?.expectedHeadcount || 40);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function statusPills() {
  const n = pendingCount();
  return `<div class="appbar-status">
    <span class="pill pend"><i class="up"></i>${n} pend.</span>
  </div>`;
}

function appBar({ title, sub = "", back = "", progress = null } = {}) {
  const lead = back
    ? `<button class="back" data-act="${esc(back)}" type="button" aria-label="Volver"><span>‹</span></button>`
    : `<button class="brand-mark" data-act="logo-tap" type="button" aria-label="Q Berries">
        <img src="./assets/logo-qberries.png" alt="" />
      </button>`;
  const bar = progress == null
    ? ""
    : `<div class="appbar-progress"><i style="width:${Math.max(0, Math.min(100, progress))}%"></i></div>`;
  return `<header class="appbar">
    <div class="appbar-row">
      <div class="appbar-lead">${lead}</div>
      <div class="appbar-titles">
        <span class="brand-kicker">Q BERRIES</span>
        <h1>${esc(title || "Solicitud de almuerzo")}</h1>
        ${sub ? `<p>${esc(sub)}</p>` : ""}
      </div>
      ${statusPills()}
    </div>
    ${bar}
  </header>`;
}

function speakBar() {
  return `<div class="speakbar ${state.lastSpeak ? "on" : ""}" id="speakbar">
    <div class="wave"><i></i><i></i><i></i></div>
    <span>${esc(state.lastSpeak || "…")}</span>
  </div>`;
}

function sectionHead(title, sub = "", noteId = "") {
  return `<header class="section-head">
    <i class="section-bar" aria-hidden="true"></i>
    <div>
      <h2>${esc(title)}</h2>
      ${sub ? `<p${noteId ? ` id="${esc(noteId)}"` : ""}>${esc(sub)}</p>` : ""}
    </div>
  </header>`;
}

function blockCard(kicker, sub = "", extra = "", noteId = "", variant = "") {
  return `<section class="section-card${variant ? ` ${variant}` : ""}">
    ${sectionHead(kicker, sub, noteId)}
    ${extra}
  </section>`;
}

function pendingCount() {
  return store.getCola().filter((r) => r.type === "lista" || r.type === "extra" || r.type === "cierre").length;
}

function dropScanCola() {
  for (const r of store.getCola()) {
    if (r.type === "pedido" || r.type === "especial") store.removeCola(r.clientId);
  }
}

const LOTES = ["Almuerzo"];
const PAGE_SIZE = 8;
const HIST_PAGE_SIZE = 5;
const HIST_PEOPLE_PAGE = 10;

function currentLote() {
  return "Almuerzo";
}

function sameMealSend(r, comida) {
  const day = todayKey(TZ);
  const sid = supervisor()?.dni || supervisor()?.id || "";
  const p = r.payload || {};
  if (p.fecha_local !== day) return false;
  if (comida && p.comida !== comida) return false;
  if (sid && p.supervisor_id && p.supervisor_id !== sid) return false;
  return true;
}

function dayAlreadySent(comida = currentLote()) {
  const t = store.getTurnoDia();
  if (t?.enviado && (!t.comida || t.comida === comida)) return true;
  return store.getHistorial().some((r) => (
    r.type === "lista" && !r.payload?.extra && r.confirmed !== false && sameMealSend(r, comida)
  ));
}

function hasNormalSend(comida = currentLote()) {
  if (dayAlreadySent(comida)) return true;
  return store.getCola().some((r) => (r.type === "lista") && !r.payload?.extra && sameMealSend(r, comida));
}

function hasSavedSend(comida = currentLote()) {
  return dayAlreadySent(comida);
}

async function syncTurnoDelDia({ timeoutMs = 2800 } = {}) {
  const s = supervisor();
  const sid = normalizeDni(s?.dni || s?.id);
  if (!sid) return store.getTurnoDia();
  const run = (async () => {
    if (!navigator.onLine) return store.getTurnoDia();
    const r = await checkTurno({
      supervisorId: sid,
      fecha: todayKey(TZ),
      comida: currentLote(),
      timeoutMs: timeoutMs || 2500,
    });
    if (!r?.ok) return store.getTurnoDia();
    store.setTurnoDia({
      dni: sid,
      fecha: r.fecha || todayKey(TZ),
      comida: r.comida || currentLote(),
      enviado: !!r.enviado,
    });
    refreshHomeLock();
    return store.getTurnoDia();
  })();
  if (!timeoutMs) return run;
  return Promise.race([
    run,
    new Promise((resolve) => window.setTimeout(() => resolve(store.getTurnoDia()), timeoutMs)),
  ]);
}

function refreshHomeLock() {
  if (state.view === "home") show("home", { replace: true, silent: true });
}

function isSendLocked() {
  return hasNormalSend() && !state.extraOn;
}

function warnLocked() {
  showAlert(
    "Ya envió",
    `El ${currentLote().toLowerCase()} de hoy ya se envió. Pulse Extra si alguien se olvidó o llegó tarde. Eso entra en Comidas extras.`
  );
}

function toggleExtra() {
  if (state.extraOn) {
    state.extraOn = false;
    store.clearMesa();
    speak("Extra apagado. Se limpió la lista.");
    show("home");
    return;
  }
  if (!hasSavedSend()) {
    showAlert("Todavía no", "Primero envíe el pedido del turno. Extra sale cuando el servidor ya guardó ese envío.");
    return;
  }
  state.extraOn = true;
  store.clearMesa();
  speak(`Extra de ${currentLote().toLowerCase()}. Se olvidó o llegó tarde. Va a Comidas extras.`);
  show("home");
}

function userIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="7" r="4"/></svg>`;
}

function ellipsisIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>`;
}

function fabBlock() {
  return `<div class="fab-wrap">
    <div class="fab-menu" id="fab-menu" hidden>
      <button type="button" data-act="go-historial">Ver historial</button>
      <button type="button" data-act="go-dni">DNI guardados</button>
      <button type="button" data-act="go-perfil">Perfil</button>
      <button type="button" data-act="do-update">Actualizar</button>
    </div>
    <button class="fab-options" id="fab-options-btn" type="button" data-act="toggle-fab" aria-label="Opciones rápidas" aria-expanded="false">
      ${ellipsisIcon()}
    </button>
  </div>`;
}

function closeFab() {
  const menu = document.getElementById("fab-menu");
  const btn = document.getElementById("fab-options-btn");
  if (menu) menu.hidden = true;
  btn?.setAttribute("aria-expanded", "false");
}

function horaMinutos(raw) {
  const m = String(raw || "").match(/(\d{1,2}):(\d{2})/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function historialConfirmados() {
  const sid = supervisor()?.dni || supervisor()?.id || "";
  return store.getHistorial().filter((r) => {
    if (r.type !== "lista" && r.type !== "extra") return false;
    if (r.confirmed === false) return false;
    if (sid && r.payload?.supervisor_id && r.payload.supervisor_id !== sid) return false;
    return true;
  });
}

function histRecordId(r) {
  return String(r.clientId || r.savedAt || "");
}

function histPersonas(r) {
  return (r.payload?.personas || []).filter((p) => p && (p.dni || p.id));
}

function histPeopleFiltered(r) {
  const q = String(state.histPeopleQuery || "").replace(/\D/g, "");
  return histPersonas(r).filter((p) => {
    if (!q) return true;
    return String(p.dni || p.id || "").includes(q);
  });
}

function histPeopleBlock(r) {
  const all = histPeopleFiltered(r);
  const pages = Math.max(1, Math.ceil(all.length / HIST_PEOPLE_PAGE));
  state.histPeoplePage = Math.min(Math.max(1, state.histPeoplePage || 1), pages);
  const start = (state.histPeoplePage - 1) * HIST_PEOPLE_PAGE;
  const slice = all.slice(start, start + HIST_PEOPLE_PAGE);
  const q = String(state.histPeopleQuery || "").replace(/\D/g, "");
  const rows = slice.map((p) => {
    const dni = p.dni || p.id || "—";
    const ape = twoApellidos(p) || p.apellido || "—";
    const nom = nameParts(p).nombre || p.nombre || "";
    return `<div class="hist-person">
      <div>
        <b>${esc(ape)}</b>
        <div class="meta">DNI ${esc(dni)}${nom ? ` · ${esc(nom)}` : ""}</div>
      </div>
      <span class="st ok">Enviado</span>
    </div>`;
  }).join("") || `<p class="sub">${q ? "Ningún DNI coincide." : "No hay personas de este envío en el celular."}</p>`;
  return `<div class="hist-people">
    <input id="hist-search" class="dni-search" type="search" inputmode="numeric" maxlength="8" enterkeyhint="search" autocomplete="off" placeholder="Buscar DNI" value="${esc(q)}">
    <div class="hist-people-list">${rows}</div>
    ${pagerHtml(state.histPeoplePage, pages, "hist-people-prev", "hist-people-next")}
  </div>`;
}

function showHistorialModal() {
  closeFab();
  const recs = historialConfirmados();
  const pages = Math.max(1, Math.ceil(recs.length / HIST_PAGE_SIZE));
  state.histPage = Math.min(Math.max(1, state.histPage || 1), pages);
  const start = (state.histPage - 1) * HIST_PAGE_SIZE;
  const slice = recs.slice(start, start + HIST_PAGE_SIZE);
  const openId = state.histOpen || "";
  if (openId && !slice.some((r) => histRecordId(r) === openId)) state.histOpen = "";
  const today = todayKey(TZ);
  const rows = slice.map((r) => {
    const p = r.payload || {};
    const n = p.trabajadores_unicos || histPersonas(r).length;
    const who = `${n || "—"} ${n === 1 ? "solicitud" : "solicitudes"}`;
    const hora = horaMinutos(p.hora_local);
    const fecha = p.fecha_local && p.fecha_local !== today
      ? String(p.fecha_local).slice(5).replace("-", "/")
      : "";
    const meta = [p.fundo || p.etapa || "—", p.comedor || "—", fecha, hora].filter(Boolean).join(" · ");
    const id = histRecordId(r);
    const open = openId === id;
    const badge = r.type === "extra" || p.extra ? "Extra" : (r.duplicate ? "Ya estaba" : "Confirmado");
    return `<div class="hist-item${open ? " open" : ""}">
      <button type="button" class="hist-row" data-act="toggle-hist" data-id="${esc(id)}" aria-expanded="${open ? "true" : "false"}">
        <div>
          <b>${esc(who)}</b>
          <div class="meta">${esc(meta)}</div>
        </div>
        <span class="st ok">${esc(badge)}</span>
        <span class="hist-chev" aria-hidden="true">${open ? "▾" : "▸"}</span>
      </button>
      ${open ? histPeopleBlock(r) : ""}
    </div>`;
  }).join("") || `<p class="sub">Aún no hay envíos confirmados en este celular.</p>`;
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Historial", "Solo este celular. Se borra a las 48 horas.")}
      <div class="hist-list">${rows}</div>
      ${pagerHtml(state.histPage, pages, "hist-page-prev", "hist-page-next")}
      <button class="btn ghost" data-act="dismiss-alert" type="button">Cerrar</button>
    </div>
  </div>`);
}

function focusHistSearch() {
  const input = document.getElementById("hist-search");
  if (!input) return;
  input.focus();
  const n = input.value.length;
  input.setSelectionRange(n, n);
}

function showPerfilModal() {
  closeFab();
  const s = supervisor();
  const names = nameParts(s || {});
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Perfil", s?.emergencia ? "Supervisor de emergencia. Eres responsable de pedir la comida." : "Supervisor del turno.")}
      <p class="hit-dni">DNI ${esc(s?.dni || s?.id || "—")}</p>
      <h3 class="hit-name">${esc(twoApellidos(s) || "—")}</h3>
      <p class="hit-cargo">${esc([names.nombre, s?.cargo].filter(Boolean).join(" · ") || "—")}</p>
      <div class="footer-actions" style="margin-top:18px">
        <button class="btn ghost" data-act="dismiss-alert" type="button">Cerrar</button>
        <button class="btn" data-act="ask-logout" type="button">Cerrar sesión</button>
      </div>
    </div>
  </div>`);
}

function showUpdatingVeil(phrase = "Actualizando app") {
  closeFab();
  const clearing = /cach[eé]/i.test(phrase);
  const heading = clearing ? "Borrando caché" : "Actualizando app";
  const subtitle = clearing ? "Un momento. Limpiamos este celular." : "Un momento. Traemos la versión nueva.";
  try {
    sessionStorage.setItem("qb_updating", "1");
    sessionStorage.setItem("qb_update_phrase", heading);
  } catch { /* ignore */ }
  document.documentElement.classList.add("is-updating");
  document.documentElement.classList.remove("update-done", "update-full");
  const title = document.getElementById("update-title");
  const sub = document.getElementById("update-sub");
  if (title) title.textContent = heading;
  if (sub) sub.textContent = subtitle;
  const bar = document.getElementById("update-bar");
  const pct = document.getElementById("update-pct");
  if (bar) bar.style.width = "0%";
  if (pct) pct.textContent = "0%";
}

function animateUpdateBar(from, to, ms) {
  return new Promise((resolve) => {
    const bar = document.getElementById("update-bar");
    const pct = document.getElementById("update-pct");
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const p = Math.round(from + (to - from) * (1 - (1 - t) ** 3));
      if (bar) bar.style.width = `${p}%`;
      if (pct) pct.textContent = `${p}%`;
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
}

function hideUpdatingVeil() {
  const bar = document.getElementById("update-bar");
  const pct = document.getElementById("update-pct");
  if (bar) bar.style.width = "100%";
  if (pct) pct.textContent = "100%";
  try {
    sessionStorage.removeItem("qb_updating");
    sessionStorage.removeItem("qb_update_phrase");
  } catch { /* ignore */ }
  window.setTimeout(() => {
    document.documentElement.classList.add("update-done");
    window.setTimeout(() => {
      document.documentElement.classList.remove("is-updating", "update-done", "update-full");
      const host = document.getElementById("alert-host");
      if (host) host.innerHTML = "";
      document.body.classList.remove("modal-open");
    }, 360);
  }, 450);
}

async function pullLatestFiles() {
  try {
    navigator.serviceWorker?.controller?.postMessage("CLEAR_APP_CACHE");
  } catch { /* sigue */ }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch { /* sigue */ }
  await Promise.all(APP_ASSETS.map((path) =>
    fetch(path, { cache: "reload", credentials: "same-origin" }).catch(() => null)
  ));
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((reg) => {
      try {
        reg.waiting?.postMessage("SKIP_WAITING");
        reg.installing?.postMessage("SKIP_WAITING");
      } catch { /* sigue */ }
      return reg.unregister();
    }));
  } catch { /* sigue */ }
}

async function runAppUpdate(phrase = "Actualizando app") {
  showUpdatingVeil(phrase);
  speak(phrase, { flush: true });
  state.swGuardUntil = Date.now() + 20000;
  const bar = animateUpdateBar(0, 85, 2000);
  await Promise.all([
    flushQueue().catch(() => {}),
    pullLatestFiles(),
  ]);
  await bar;
  await animateUpdateBar(85, 100, 350);
  try { sessionStorage.setItem("qb_updating", "100"); } catch { /* ignore */ }
  document.documentElement.classList.add("update-full");
  const next = new URL(location.href);
  next.searchParams.set("_up", String(Date.now()));
  window.setTimeout(() => location.replace(next.href), 400);
}

function stripUpdateQuery() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has("_up")) return;
    url.searchParams.delete("_up");
    const qs = url.searchParams.toString();
    history.replaceState(null, "", `${url.pathname}${qs ? `?${qs}` : ""}${url.hash}`);
  } catch { /* ignore */ }
}

function watchAppUpdates() {
  if (!("serviceWorker" in navigator)) return;
  const ping = () => {
    if (document.visibilityState !== "visible") return;
    navigator.serviceWorker.getRegistration()
      .then((reg) => reg?.update())
      .catch(() => {});
  };
  window.setInterval(ping, 60 * 1000);
  document.addEventListener("visibilitychange", ping);
  window.addEventListener("online", ping);
  window.addEventListener("focus", ping);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (Date.now() < state.swGuardUntil) return;
    try {
      if (sessionStorage.getItem("qb_updating")) return;
    } catch { /* ignore */ }
    waitThenReload();
  });
}

function waitThenReload() {
  if (state.loggingIn || state.handlingScan || state.busy) {
    window.setTimeout(waitThenReload, 1600);
    return;
  }
  state.swGuardUntil = Date.now() + 20000;
  showUpdatingVeil();
  try { sessionStorage.setItem("qb_updating", "100"); } catch { /* ignore */ }
  location.reload();
}

function versionNewer(local, remote) {
  const a = String(local || "").split(".").map((n) => Number(n) || 0);
  const b = String(remote || "").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((b[i] || 0) > (a[i] || 0)) return true;
    if ((b[i] || 0) < (a[i] || 0)) return false;
  }
  return false;
}

async function detectAppUpdate() {
  let remote = {};
  try {
    const res = await fetch("./data/config.json", { cache: "reload" });
    remote = await res.json();
  } catch { /* sin red */ }
  let waiting = false;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await Promise.race([reg.update(), new Promise((r) => setTimeout(r, 800))]);
      waiting = !!(reg.waiting || reg.installing);
    }
  } catch { /* sin sw */ }
  const latest = String(remote.version || "").trim();
  return {
    latest,
    newer: versionNewer(APP_VERSION, latest) || waiting,
  };
}

function showUpdateModal() {
  closeFab();
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Actualizar", "Baja la última versión y recarga la app.")}
      <p class="app-ver" id="update-ver">Versión ${esc(APP_VERSION)}</p>
      <p class="update-status" id="update-status">Buscando en el servidor…</p>
      <div class="update-actions">
        <button class="btn leaf" data-act="clear-cache" type="button">Borrar caché</button>
        <button class="btn leaf" data-act="reload-app" type="button">Actualizar app</button>
      </div>
    </div>
  </div>`);
  detectAppUpdate().then((info) => {
    const status = document.getElementById("update-status");
    const ver = document.getElementById("update-ver");
    if (!status) return;
    if (info.newer) {
      status.textContent = info.latest
        ? `Hay una nueva: ${info.latest}. Pulse Actualizar app.`
        : "Hay una actualización. Pulse Actualizar app.";
      status.classList.add("new");
      if (ver && info.latest) ver.textContent = `Esta app ${APP_VERSION} · Nueva ${info.latest}`;
    } else {
      status.textContent = "Al día. Igual puede pulsar Actualizar app para bajar lo último.";
      status.classList.add("ok");
    }
  }).catch(() => {
    const status = document.getElementById("update-status");
    if (status) status.textContent = "Sin red. Pulse Actualizar app cuando tenga señal.";
  });
}

function rememberDni(person) {
  const id = normalizeDni(person?.dni || person?.id);
  if (!id) return;
  store.upsertDniGuardado({
    id,
    dni: id,
    apellido: person.apellido || twoApellidos(person),
    nombre: person.nombre || nameParts(person).nombre,
    cargo: person.cargo || person.area || "",
    temporal: !!person.temporal,
  });
}

function hydrateDniGuardados() {
  for (const p of getMesa()) rememberDni(p);
  for (const r of recordsOfToday(TZ)) {
    if (r.type !== "lista") continue;
    for (const p of r.payload?.personas || []) rememberDni(p);
  }
}

function filteredDniGuardados() {
  const q = pickNorm(state.dniQuery || "");
  const compact = q.replace(/\s/g, "");
  return store.getDniGuardados().filter((p) => {
    if (!q) return true;
    const hay = pickNorm(`${p.dni || p.id || ""} ${p.apellido || ""} ${p.nombre || ""} ${p.cargo || ""}`);
    return hay.includes(q) || hay.replace(/\s/g, "").includes(compact);
  });
}

function dniSelectedIds() {
  return Object.keys(state.dniSelected || {}).filter((id) => state.dniSelected[id]);
}

function focusDniSearch() {
  const input = document.getElementById("dni-search");
  if (!input) return;
  input.focus();
  const n = input.value.length;
  input.setSelectionRange(n, n);
}

function showDniModal() {
  closeFab();
  hydrateDniGuardados();
  if (!state.dniSelected) state.dniSelected = {};
  const all = filteredDniGuardados();
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  state.dniPage = Math.min(Math.max(1, state.dniPage || 1), pages);
  const start = (state.dniPage - 1) * PAGE_SIZE;
  const rows = all.slice(start, start + PAGE_SIZE);
  const nSel = dniSelectedIds().length;
  const allOn = all.length > 0 && all.every((p) => state.dniSelected[p.id]);
  const list = rows.map((p) => {
    const onMesa = getMesa().some((m) => m.id === p.id);
    const sel = !!state.dniSelected[p.id];
    return `<button type="button" class="dni-row${sel ? " sel" : ""}" data-act="toggle-dni" data-id="${esc(p.id)}">
      <span class="dni-check${sel ? " on" : ""}" aria-hidden="true"></span>
      <div>
        <b>${esc(p.apellido || "—")}</b>
        <div class="meta">DNI ${esc(p.dni || p.id)} · ${esc(p.nombre || "")}</div>
      </div>
      <span class="st ${onMesa ? "ok" : "now"}">${onMesa ? "En lista" : (sel ? "Listo" : "Elegir")}</span>
    </button>`;
  }).join("") || `<p class="sub">Aún no hay DNI. Cuando el supervisor guarda a alguien bien, queda aquí.</p>`;
  const q = state.dniQuery || "";
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("DNI guardados", "Marque quién entra a la lista. Puede elegir todos o solo algunos.")}
      <input id="dni-search" class="dni-search" type="search" enterkeyhint="search" autocomplete="off" placeholder="Buscar DNI o apellido" value="${esc(q)}">
      ${all.length ? `<div class="dni-toolbar">
        <button type="button" class="dni-all" data-act="toggle-dni-all">
          <span class="dni-check${allOn ? " on" : ""}" aria-hidden="true"></span>
          Seleccionar todo
        </button>
        <span class="dni-count">${nSel} de ${all.length}</span>
      </div>` : ""}
      <div class="dni-list">${list}</div>
      ${pagerHtml(state.dniPage, pages, "dni-page-prev", "dni-page-next")}
      <div class="footer-actions">
        <button class="btn ghost" data-act="dismiss-alert" type="button">Cerrar</button>
        <button class="btn leaf" data-act="use-saved-dnis" type="button"${nSel ? "" : " disabled"}>Usar${nSel ? ` (${nSel})` : ""}</button>
      </div>
    </div>
  </div>`);
}

function showTempPersonModal() {
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Persona temporal", "No está en la base. DNI y nombre. Se guarda en este celular y se borra al cerrar sesión.")}
      <div class="field" id="fTempDni">
        <label>DNI</label>
        <input id="tempDni" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="8 dígitos">
      </div>
      <div class="field" id="fTempNom">
        <label>Nombre</label>
        <input id="tempNombre" autocomplete="off" placeholder="Apellidos y nombres" autocapitalize="characters">
      </div>
      <div class="footer-actions" style="margin-top:8px">
        <button class="btn ghost" data-act="dismiss-alert" type="button">Cerrar</button>
        <button class="btn leaf" data-act="save-temp-person" type="button">Guardar</button>
      </div>
    </div>
  </div>`);
  window.setTimeout(() => document.getElementById("tempDni")?.focus(), 50);
}

function showLogoutWarn() {
  closeFab();
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal" role="dialog" aria-modal="true" data-act="stay">
      <h3>¿Cerrar sesión?</h3>
      <p>Se borran los DNI guardados en este celular y la lista de hoy.</p>
      <div class="footer-actions">
        <button class="btn ghost" data-act="dismiss-alert" type="button">No</button>
        <button class="btn" data-act="logout" type="button">Cerrar sesión</button>
      </div>
    </div>
  </div>`);
}

function pairFooter(cancelAct, cancelLabel, okAct, okLabel, okDisabled = false) {
  return `<footer class="footer">
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" data-act="${esc(cancelAct)}">${esc(cancelLabel)}</button>
      <button type="button" class="btn btn-primary" data-act="${esc(okAct)}"${okDisabled ? " disabled" : ""}>${esc(okLabel)}</button>
    </div>
  </footer>`;
}

function soloFooter(okAct, okLabel, okDisabled = false) {
  return `<footer class="footer">
    <div class="form-actions solo">
      <button type="button" class="btn btn-primary" data-act="${esc(okAct)}"${okDisabled ? " disabled" : ""}>${esc(okLabel)}</button>
    </div>
  </footer>`;
}

function footer(active, extra = "") {
  return extra ? `<footer class="footer">${extra}</footer>` : "";
}

function lotePills() {
  const extra = !!state.extraOn;
  return `<div class="lote-pills" role="group" aria-label="Comida">
    <button type="button" class="${extra ? "" : "on"}" data-act="set-lote" data-id="Almuerzo">Almuerzo</button>
    <button type="button" class="extra${extra ? " on" : ""}" data-act="toggle-extra">Extra</button>
  </div>`;
}

function loteCard() {
  const locked = isSendLocked();
  const extra = !!state.extraOn;
  return `<section class="section-card">
    ${extra ? `<p class="extra-note">Modo extra activo. Se olvidó o llegó tarde. Va a Comidas extras.</p>` : ""}
    ${locked ? `<p class="extra-note">Ya envió el almuerzo hoy. Todo está bloqueado. Pulse Extra para olvidados o tardanzas.</p>` : ""}
    ${!locked && !extra && !navigator.onLine ? `<p class="extra-note">Sin señal. Puede escanear y enviar. Queda pendiente en este celular hasta tener internet.</p>` : ""}
    ${sectionHead("Turno", extra ? "Escanee solo a quien falta. Entra como extra." : "Almuerzo o Extra. Después presente el QR de cada persona.")}
    ${lotePills()}
  </section>`;
}

function comedores() {
  return [
    ...Array.from({ length: 11 }, (_, i) => `Comedor ${i + 1}`),
    "Garita 1",
    "Garita 2",
    "Galpon",
    "Comedor Administrativo",
  ];
}

function fundos() {
  return ["LICAPA I", "LICAPA II", "LICAPA III"];
}

function currentFundo() {
  const list = fundos();
  const saved = store.getPrefs().fundo || store.getPrefs().etapa;
  return list.includes(saved) ? saved : list[0];
}

function currentEtapa() {
  return currentFundo();
}

function currentComedor() {
  const list = comedores();
  const saved = store.getPrefs().comedor;
  return list.includes(saved) ? saved : list[0];
}

function campoLotes() {
  const list = Array.isArray(state.lotes) ? state.lotes : [];
  if (list.length) {
    return [...list].sort((a, b) => Number(a.lote) - Number(b.lote) || String(a.codLote).localeCompare(String(b.codLote)));
  }
  return Array.from({ length: 10 }, (_, i) => ({
    codLote: `L${i + 1}`,
    lote: String(i + 1),
    modulo: "",
    turno: "",
    variedad: "",
  }));
}

function loteOptionLabel(row) {
  const bits = [`L${row.lote || row.codLote}`];
  if (row.modulo) bits.push(row.modulo);
  if (row.turno) bits.push(`T${row.turno}`);
  return bits.join(" · ");
}

function currentCampoLote() {
  const list = campoLotes();
  const saved = store.getPrefs().campoLote;
  return list.some((r) => r.codLote === saved) ? saved : (list[0]?.codLote || "");
}

function currentCampoLoteLabel() {
  const id = currentCampoLote();
  const row = campoLotes().find((r) => r.codLote === id);
  return row ? loteOptionLabel(row) : id;
}

function pickNorm(s) {
  return String(s || "").toLowerCase().replace(/[·•.,\-_/]/g, " ").replace(/\s+/g, " ").trim();
}

function pickSelect(id, value, options) {
  const current = options.find(([val]) => val === value) || options[0] || ["", "—"];
  const rows = options.map(([val, lab]) => {
    const on = val === current[0];
    return `<button type="button" class="pick-opt${on ? " on" : ""}" data-act="pick-opt" data-pick="${esc(id)}" data-id="${esc(val)}" data-label="${esc(lab)}">${esc(lab)}</button>`;
  }).join("");
  return `<div class="pick" data-pick="${esc(id)}" data-value="${esc(current[0])}">
    <button type="button" class="pick-btn" data-act="pick-open" data-pick="${esc(id)}">
      <span class="pick-value">${esc(current[1])}</span>
    </button>
    <div class="pick-panel" hidden>
      <div class="pick-list">${rows}</div>
    </div>
  </div>`;
}

function closePicks() {
  document.querySelectorAll(".pick.open").forEach((el) => {
    el.classList.remove("open");
    const panel = el.querySelector(".pick-panel");
    const input = el.querySelector(".pick-search");
    if (panel) panel.hidden = true;
    if (input) {
      input.value = "";
      filterPick(el, "");
    }
  });
}

function filterPick(wrap, query) {
  const q = pickNorm(query);
  const compact = q.replace(/\s/g, "");
  let n = 0;
  wrap.querySelectorAll(".pick-opt").forEach((opt) => {
    const hay = pickNorm(opt.dataset.search || opt.textContent || "");
    const hayC = hay.replace(/\s/g, "");
    const ok = !q || hay.includes(q) || hayC.includes(compact);
    opt.hidden = !ok;
    if (ok) n += 1;
  });
  const empty = wrap.querySelector(".pick-empty");
  if (empty) empty.hidden = n > 0;
}

function onPickInput(e) {
  if (e.target.id === "dni-search") {
    state.dniQuery = e.target.value;
    state.dniPage = 1;
    showDniModal();
    const input = document.getElementById("dni-search");
    if (input) {
      input.focus();
      const n = input.value.length;
      input.setSelectionRange(n, n);
    }
    return;
  }
  if (e.target.id === "hist-search") {
    state.histPeopleQuery = e.target.value.replace(/\D/g, "").slice(0, 8);
    state.histPeoplePage = 1;
    showHistorialModal();
    focusHistSearch();
    return;
  }
  if (!e.target.classList.contains("pick-search")) return;
  const wrap = e.target.closest(".pick");
  if (wrap) filterPick(wrap, e.target.value);
}

function onPickKey(e) {
  if (e.key === "Escape") closePicks();
  if (e.key === "Enter" && e.target.classList.contains("pick-search")) {
    e.target.closest(".pick")?.querySelector(".pick-opt:not([hidden])")?.click();
  }
}

function authLabel() {
  const s = supervisor();
  if (!s) return "—";
  return twoApellidos(s) || s.apellido || s.nombreCompleto || "—";
}

function mealWord(lote, n) {
  const map = {
    Desayuno: ["desayuno", "desayunos"],
    Almuerzo: ["almuerzo", "almuerzos"],
    Cena: ["cena", "cenas"],
  };
  const pair = map[lote] || ["pedido", "pedidos"];
  return n === 1 ? pair[0] : pair[1];
}

function comedorPills() {
  const cur = currentComedor();
  return `<div class="lote-pills comedor-pills" role="group" aria-label="Comedor">
    ${comedores().map((name) => `<button type="button" class="${cur === name ? "on" : ""}" data-act="set-comedor" data-id="${esc(name)}">${esc(name)}</button>`).join("")}
  </div>`;
}

function ensureAlertHost() {
  let host = document.getElementById("alert-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "alert-host";
    document.body.appendChild(host);
  }
  if (!host.dataset.bound) {
    host.dataset.bound = "1";
    host.addEventListener("click", onClick);
    host.addEventListener("input", onPickInput);
    host.addEventListener("keydown", onPickKey);
  }
  return host;
}

function openAlert(html) {
  ensureAlertHost().innerHTML = html;
  document.body.classList.add("modal-open");
}

function showSummaryModal() {
  const mesa = getMesa();
  const meal = currentLote();
  const n = mesa.length;
  const fundoOpts = fundos().map((name) => [name, name]);
  const comedorOpts = comedores().map((name) => [name, name]);
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      <div class="summary-top">
        ${sectionHead("Solicitud de almuerzo", state.extraOn ? "Entra como extra (se olvidó o llegó tarde). Va a Comidas extras." : "Confirme fundo y comedor antes de enviar.")}
      </div>
      <div class="summary-stat">
        <b>${n}</b>
        <span>${n} ${n === 1 ? "solicitud" : "solicitudes"} de ${mealWord(meal, n)}</span>
      </div>
      <p class="summary-auth"><span>Autoriza</span><strong>${esc(authLabel())}</strong></p>
      <div class="summary-fields">
        <div class="pick-field">
          <p class="pick-label">Fundo</p>
          ${pickSelect("sel-fundo", currentFundo(), fundoOpts)}
        </div>
        <div class="pick-field">
          <p class="pick-label">Comedor</p>
          ${pickSelect("sel-comedor", currentComedor(), comedorOpts)}
        </div>
      </div>
      <div class="footer-actions">
        <button class="btn ghost" data-act="dismiss-alert" type="button">Cerrar</button>
        <button class="btn leaf" data-act="send-lista" type="button"${n ? "" : " disabled"}>${state.extraOn ? "Enviar extra" : "Enviar"}</button>
      </div>
    </div>
  </div>`);
}

function pageSlice(list, page = state.mesaPage) {
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const safe = Math.min(Math.max(1, page), pages);
  state.mesaPage = safe;
  const start = (safe - 1) * PAGE_SIZE;
  return { rows: list.slice(start, start + PAGE_SIZE), page: safe, pages, total: list.length };
}

function pagerHtml(page, pages, prevAct = "page-prev", nextAct = "page-next") {
  if (pages <= 1) return "";
  return `<div class="pager">
    <button type="button" data-act="${esc(prevAct)}" ${page <= 1 ? "disabled" : ""}>‹</button>
    <span>${page} / ${pages}</span>
    <button type="button" data-act="${esc(nextAct)}" ${page >= pages ? "disabled" : ""}>›</button>
  </div>`;
}

function render(html) {
  document.getElementById("app").innerHTML = html;
  const scroll = document.querySelector(".scroll");
  if (scroll) preventBounce(scroll);
}

function showAlert(title, text) {
  speak(text);
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal" role="dialog" aria-modal="true" data-act="stay">
      <button class="modal-close" data-act="dismiss-alert" type="button" aria-label="Cerrar"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.2 5.1 5.1 6.2 10.9 12l-5.8 5.8 1.1 1.1L12 13.1l5.8 5.8 1.1-1.1L13.1 12l5.8-5.8-1.1-1.1L12 10.9 6.2 5.1z"/></svg></button>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      <button class="btn" data-act="dismiss-alert" type="button">Entendido</button>
    </div>
  </div>`);
}

function dismissAlert() {
  document.getElementById("alert-host")?.replaceChildren();
  document.body.classList.remove("modal-open");
}

function alertIsOpen() {
  return !!document.getElementById("alert-host")?.childElementCount;
}

function resumeCam() {
  if (state.loggingIn) return;
  if (state.view !== "supervisor") return;
  const video = document.getElementById("cam");
  if (video?.srcObject && scanner.active) {
    video.play().catch(() => {});
    return;
  }
  startCamHere();
}

function welcomeView() {
  render(`<section class="welcome">
    <div class="welcome-hero">
      <figure class="welcome-frame">
        <img src="./assets/entrada.png" alt="" width="270" height="320" decoding="async" fetchpriority="high" />
      </figure>
    </div>
    <div class="welcome-sheet">
      <h1>Pide tu <span>comida</span></h1>
      <p>Rica, rápida y lista para el turno.</p>
      <div class="dots" aria-hidden="true"><i class="on"></i><i></i><i></i></div>
      <button class="cta" data-act="enter" type="button">Empezar</button>
      ${installSlot()}
    </div>
  </section>`);
}

function lockView() {
  render(`<section class="lock">
    <div class="welcome-hero">
      <figure class="welcome-frame">
        <img src="./assets/entrada.png" alt="" />
      </figure>
    </div>
    <h1>Ábrela en el celular</h1>
    <p>Esta app es solo para el teléfono. En computadora no se usa.</p>
  </section>`);
}

function qrIcon() {
  return `<svg class="qr-ic" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 3h8v8H3zm2 2v4h4V5zm8-2h8v8h-8zm2 2v4h4V5zM3 13h8v8H3zm2 2v4h4v-4zm10-2h3v3h-3zm5 0h3v3h-3zm-5 5h3v5h-3zm5 5h3v3h-3zm-2-3h2v2h-2z"/></svg>`;
}

function camActions() {
  return `<div class="cam-actions">
    <button class="btn cam" data-act="start-cam" type="button">${qrIcon()} Activar cámara QR</button>
    <button class="btn stop" data-act="stop-cam" type="button">Detener cámara</button>
  </div>`;
}

function scanBox() {
  return `<div class="scan-wrap">
    <div class="scan-box">
      <video id="cam" playsinline muted></video>
      <div class="finder-sq"></div>
    </div>
    ${camActions()}
  </div>`;
}

function startCamHere() {
  const video = document.getElementById("cam");
  if (!video) return;
  if (state.scanMode === "wrk" && isSendLocked()) {
    scanner.stop();
    setScanLive("Ya envió. Pulse Extra si alguien se olvidó o llegó tarde.", false);
    return;
  }
  setScanLive("Abriendo cámara…");
  scanner.start(video, onScan).then(() => {
    setScanLive("Cámara lista. Acerca el QR al recuadro.");
  }).catch(() => {
    setScanLive("Toca Activar cámara QR y permite el acceso.", false);
    speak("Toca Activar cámara QR y permite el acceso.");
  });
}

function goScan(mode) {
  state.scanMode = mode;
  if (mode === "wrk") state.formType = "pedido";
  if (mode === "sup") show("supervisor");
  else show("home");
}

function forkIcon() {
  return `<span class="fork" aria-hidden="true"><svg viewBox="0 0 32 32" width="20" height="20"><path fill="currentColor" d="M8 3h2.1v8.4c0 .6.5 1.1 1.1 1.1s1.1-.5 1.1-1.1V3H14.4v8.4c0 .6.5 1.1 1.1 1.1s1.1-.5 1.1-1.1V3H18.8v8.6a4.7 4.7 0 0 1-3.7 4.6V29h-2.3V16.2A4.7 4.7 0 0 1 8 11.6V3z"/></svg></span>`;
}

function getMesa() {
  return store.getMesa();
}

function setMesa(list) {
  store.setMesa(list);
}

function upsertMesa(person) {
  setMesa([person, ...getMesa().filter((p) => p.id !== person.id)]);
}

function removeMesaPerson(id) {
  const day = todayKey(TZ);
  setMesa(getMesa().filter((p) => p.id !== id));
  store.removeCola(`scan:${day}:${id}`);
  for (const r of store.getCola()) {
    if ((r.type === "pedido" || r.type === "especial") && r.payload?.trabajador_id === id) {
      store.removeCola(r.clientId);
    }
  }
}

function refreshPendPill() {
  const wrap = document.querySelector(".appbar-status");
  if (!wrap) return;
  const n = pendingCount();
  let pill = wrap.querySelector(".pill.pend");
  if (!pill) {
    pill = document.createElement("span");
    pill.className = "pill pend";
    wrap.appendChild(pill);
  }
  pill.className = "pill pend";
  pill.innerHTML = `<i class="up"></i>${n} pend.`;
}

function askDropMesa(id, name) {
  const sent = getMesa().find((p) => p.id === id)?.status === "enviado";
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal" role="dialog" aria-modal="true" data-act="stay">
      <h3>¿Quitar de la lista?</h3>
      <p>${esc(name || "Esta persona")} ${sent ? "ya se envió. Solo se quita de esta pantalla." : "no se enviará."}</p>
      <div class="footer-actions">
        <button class="btn ghost" data-act="dismiss-alert" type="button">No</button>
        <button class="btn" data-act="drop-mesa" data-id="${esc(id)}" type="button">Quitar</button>
      </div>
    </div>
  </div>`);
}

function scanHelp() {
  return `<aside class="scan-help">
    <p class="scan-help-title">Qué hacer</p>
    <ol>
      <li>Verde: solo supervisores. Escanee su QR.</li>
      <li>Rojo: cualquier persona, por emergencia.</li>
      <li>Si entra en rojo, usted pide la comida. Tenga cuidado.</li>
    </ol>
  </aside>`;
}

function showEmergencyWarn() {
  openAlert(`<div class="modal-back" data-act="dismiss-alert">
    <div class="modal summary-modal" role="dialog" aria-modal="true" data-act="stay">
      ${sectionHead("Cualquier persona", "El botón rojo deja entrar a cualquiera. Serás responsable de solicitar la comida. Escanea tu QR. Después podrás elegir fundo y comedor.")}
      <p class="extra-note">Ten cuidado, por favor. Esto es solo por emergencia.</p>
      <div class="footer-actions solo" style="margin-top:8px">
        <button class="btn leaf" data-act="confirm-emergency" type="button">Entendido</button>
      </div>
    </div>
  </div>`);
}

function setEmergencyUi(on) {
  document.querySelector(".emerg-fab")?.classList.toggle("on", on);
  document.querySelector(".scan-panel")?.classList.toggle("is-emerg", on);
  const tag = document.getElementById("access-tag");
  if (tag) {
    tag.className = `access-tag ${on ? "red" : "green"}`;
    tag.textContent = on ? "Cualquier persona" : "Solo supervisores";
  }
  const sub = document.querySelector(".scan-panel .scan-head .section-head p");
  if (sub) {
    sub.textContent = on
      ? "Rojo activo. Escanea tu QR. Puede entrar cualquiera."
      : "Verde: solo supervisores autorizados. Escanee su QR.";
  }
  const bar = document.querySelector(".appbar-titles p");
  if (bar) bar.textContent = on ? "Rojo · cualquier persona" : "Verde · solo supervisores";
  setScanLive(on ? "Escanea tu QR. Cualquier persona puede entrar." : "Listo para escanear el QR de supervisor.", true);
}

function toggleEmergencySup() {
  if (state.loggingIn) return;
  if (state.emergencyPending) {
    state.emergencyPending = false;
    dismissAlert();
    speak("Verde. Solo supervisores.", { flush: true });
    setEmergencyUi(false);
    resumeCam();
    return;
  }
  state.emergencyPending = true;
  speak("Rojo. Cualquier persona puede entrar. Ten cuidado, por favor.", { flush: true });
  setEmergencyUi(true);
  showEmergencyWarn();
}

function enterEmergencySupervisor(person) {
  const dni = normalizeDni(person?.dni || person?.id);
  if (!isSesionDni(dni)) {
    speak("Código no válido. Solo el DNI.");
    showScanHit({
      dni: dni || "—",
      nombre: "No se leyó un DNI",
      cargo: "—",
      ok: false,
      note: "Acerca de nuevo el código.",
    });
    return;
  }
  const official = findSupervisor({ dni });
  if (official) {
    state.emergencyPending = false;
    showLoginGate(official);
    return;
  }
  const parsed = nameParts(person);
  state.emergencyPending = false;
  showLoginGate({
    id: dni,
    dni,
    apellido: parsed.apellido,
    nombre: parsed.nombre,
    nombreCompleto: parsed.nombreCompleto,
    cargo: "Supervisor de emergencia",
    emergencia: true,
  });
}

function supervisorView() {
  state.scanMode = "sup";
  const emerg = !!state.emergencyPending;
  render(`<div class="shell">
    ${appBar({ title: "Pedir almuerzo", sub: emerg ? "Rojo · cualquier persona" : "Verde · solo supervisores", back: "back-welcome" })}
    <div class="scan-fit">
      <section class="section-card scan-panel${emerg ? " is-emerg" : ""}">
        <div class="scan-head">
          ${sectionHead("Permiso", emerg ? "Rojo activo. Escanea tu QR. Puede entrar cualquiera." : "Verde: solo supervisores autorizados. Escanee su QR.")}
        </div>
        ${!navigator.onLine ? `<p class="extra-note">Se necesita señal para iniciar sesión. Así se sabe si este supervisor ya envió hoy.</p>` : ""}
        <p class="access-tag ${emerg ? "red" : "green"}" id="access-tag">${emerg ? "Cualquier persona" : "Solo supervisores"}</p>
        ${scanBox()}
        <p class="scan-live" id="scan-live">${emerg ? "Escanea tu QR. Cualquier persona puede entrar." : "Toca Activar cámara QR."}</p>
        ${scanHitBox()}
        ${scanHelp()}
      </section>
    </div>
    <button class="emerg-fab${emerg ? " on" : ""}" data-act="add-emergency-sup" type="button" aria-label="Entrar como cualquier persona">${userIcon()}<b>Cualquiera</b></button>
  </div>`);
  startCamHere();
}

function mesaRows(mesa) {
  if (!mesa.length) {
    return `<div class="empty-mesa">${forkIcon()}<p>Aún nadie. Escanea al primero.</p></div>`;
  }
  const { rows } = pageSlice(mesa);
  return rows.map((p) => {
    const st = p.status === "enviado" ? "Listo" : p.status === "pendiente" ? "Guardado" : "En lista";
    const kind = p.status === "enviado" ? "ok" : p.status === "pendiente" ? "wait" : "now";
    return `<div class="person-row">
      ${forkIcon()}
      <div>
        <b>${esc(p.apellido || twoApellidos(p))}</b>
        <div class="meta">DNI ${esc(p.id)} · ${esc(p.nombre || "")}${p.temporal ? " · Temporal" : ""}</div>
      </div>
      <span class="st ${kind}">${st}</span>
      <button class="row-del" data-act="ask-drop-mesa" data-id="${esc(p.id)}" data-name="${esc(p.apellido || twoApellidos(p))}" type="button" aria-label="Quitar"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.2 5.1 5.1 6.2 10.9 12l-5.8 5.8 1.1 1.1L12 13.1l5.8 5.8 1.1-1.1L13.1 12l5.8-5.8-1.1-1.1L12 10.9 6.2 5.1z"/></svg></button>
    </div>`;
  }).join("");
}

function mesaCountCopy(n) {
  const meal = currentLote().toLowerCase();
  if (!n) return { note: `Aún nadie para ${meal}`, unit: "personas" };
  return { note: `Van a ${meal}`, unit: n === 1 ? "persona" : "personas" };
}

function mesaCountCard(n) {
  const copy = mesaCountCopy(n);
  return `<section class="section-card count-card">
    ${sectionHead("Personas", copy.note, "mesa-note")}
    <div class="count-live" aria-live="polite">
      <b id="mesa-num">${n}</b>
      <span id="mesa-unit">${esc(copy.unit)}</span>
    </div>
  </section>`;
}

function refreshMesaUi() {
  const mesa = getMesa();
  const slice = pageSlice(mesa);
  const list = document.getElementById("mesa-list");
  const count = document.getElementById("mesa-note");
  const num = document.getElementById("mesa-num");
  const unit = document.getElementById("mesa-unit");
  const pager = document.getElementById("mesa-pager");
  const copy = mesaCountCopy(mesa.length);
  if (list) list.innerHTML = mesaRows(mesa);
  if (count) count.textContent = copy.note;
  if (num) num.textContent = String(mesa.length);
  if (unit) unit.textContent = copy.unit;
  if (pager) pager.innerHTML = pagerHtml(slice.page, slice.pages);
  const send = document.querySelector('.form-actions [data-act="go-summary"], .footer-actions [data-act="go-summary"], .form-actions [data-act="send-lista"], .footer-actions [data-act="send-lista"]');
  if (send) send.disabled = !mesa.length;
  refreshPendPill();
}

function setScanLive(text, ok = true) {
  const el = document.getElementById("scan-live");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("bad", !ok);
}

function scanHitBox() {
  return `<article class="hit-card" id="scan-hit" hidden></article>`;
}

function abortLogin(title, text) {
  state.loggingIn = false;
  store.clearSesion();
  store.clearTurnoDia();
  dismissAlert();
  speak(title, { flush: true });
  showAlert(title, text);
  if (state.view !== "supervisor") show("supervisor", { replace: true });
  else startCamHere();
}

function showLoginGate(person) {
  const dni = normalizeDni(person?.dni || person?.id);
  if (!isSesionDni(dni)) {
    speak("Código no válido. Solo el DNI.");
    return;
  }
  if (!navigator.onLine) {
    speak("Se necesita señal para iniciar sesión");
    showAlert(
      "Se necesita señal",
      "Para entrar hay que preguntar al servidor si este supervisor ya mandó hoy. Así el segundo celular sale bloqueado y solo Extra. Conecte internet e intente de nuevo."
    );
    return;
  }
  const ap = twoApellidos(person);
  state.loggingIn = true;
  state.emergencyPending = false;
  state.scanQueue.length = 0;
  scanner.stop();
  const turnoReady = checkTurno({
    supervisorId: dni,
    fecha: todayKey(TZ),
    comida: currentLote(),
  });
  speak(`Bienvenido${ap ? ` ${ap}` : ""}`, { flush: true });
  openAlert(`<div class="modal-back login-gate" data-act="stay">
    <div class="modal login-load" role="dialog" aria-modal="true" data-act="stay">
      <p class="login-kicker">Q BERRIES</p>
      <h3>Iniciando sesión</h3>
      <p>Bienvenido${ap ? `, ${esc(ap)}` : ""}</p>
      <div class="login-bar" aria-hidden="true"><i id="login-bar"></i></div>
      <p class="login-pct" id="login-pct">0%</p>
    </div>
  </div>`);
  const bar = document.getElementById("login-bar");
  const pct = document.getElementById("login-pct");
  const start = performance.now();
  const dur = 2400;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const p = Math.round((1 - (1 - t) ** 3) * 100);
    if (bar) bar.style.width = `${p}%`;
    if (pct) pct.textContent = `${p}%`;
    if (t < 1) {
      requestAnimationFrame(tick);
      return;
    }
    if (bar) bar.style.width = "100%";
    if (pct) pct.textContent = "100%";
    window.setTimeout(async () => {
      let r = null;
      try {
        r = await Promise.race([
          turnoReady,
          new Promise((resolve) => window.setTimeout(() => resolve({ ok: false, error: "timeout" }), 8000)),
        ]);
      } catch {
        r = { ok: false, error: "sin_red" };
      }
      if (!r?.ok) {
        abortLogin(
          "Se necesita señal",
          "No se pudo preguntar al servidor. Sin eso no se entra. Así no se manda el almuerzo dos veces. Intente con internet."
        );
        return;
      }
      if (!store.setSesion(person)) {
        abortLogin("No se pudo entrar", "Intente de nuevo el QR.");
        return;
      }
      store.setTurnoDia({
        dni,
        fecha: r.fecha || todayKey(TZ),
        comida: r.comida || currentLote(),
        enviado: !!r.enviado,
      });
      ensureWorkers();
      state.loggingIn = false;
      state.lastSpeak = "";
      dismissAlert();
      show("home");
      if (r.enviado) speak("Hoy ya envió. Solo extra.", { flush: true });
    }, 280);
  };
  requestAnimationFrame(tick);
}

function showScanHit({ dni = "—", nombre = "—", cargo = "—", ok = true, note = "" }) {
  const host = document.getElementById("scan-hit");
  if (host) {
    host.hidden = false;
    host.className = `hit-card ${ok ? "ok" : "bad"}`;
    host.innerHTML = `
      <div class="hit-top">
        <span class="hit-label">Identificación</span>
        <span class="hit-state">${ok ? "Confirmado" : "No autorizado"}</span>
      </div>
      <p class="hit-dni">DNI ${esc(dni)}</p>
      <h3 class="hit-name">${esc(nombre || "—")}</h3>
      <p class="hit-cargo">${esc(cargo || "—")}</p>
      ${note ? `<p class="hit-note">${esc(note)}</p>` : ""}`;
  }
  setScanLive(note || `DNI ${dni}`, ok);
}

function homeView() {
  if (!supervisor()) {
    show("supervisor");
    return;
  }
  state.scanMode = "wrk";
  state.formType = "pedido";
  const s = supervisor();
  const mesa = getMesa();
  const slice = pageSlice(mesa);
  render(`<div class="shell${isSendLocked() ? " is-locked" : ""}">
    ${appBar({ title: "Solicitud de almuerzo", sub: `Turno · ${twoApellidos(s) || "supervisor"}${s?.emergencia ? " · Emergencia" : ""}` })}
    <div class="scroll">
      ${loteCard()}
      <section class="section-card">
        <div class="scan-head">
          ${sectionHead("Escaneo", isSendLocked() ? "Bloqueado. Pulse Extra para olvidados o tardanzas." : (state.extraOn ? "Solo quien falta. Entra como extra." : "Presente el QR de cada persona."))}
          <button class="user-add" data-act="add-temp-person" type="button" aria-label="Agregar persona que no está en la base">${userIcon()}</button>
        </div>
        ${scanBox()}
        <p class="scan-live" id="scan-live">${isSendLocked() ? "Ya envió. Pulse Extra si alguien se olvidó o llegó tarde." : "Listo para el siguiente QR."}</p>
        ${scanHitBox()}
      </section>
      ${mesaCountCard(mesa.length)}
      <div class="mesa" id="mesa-list">${mesaRows(mesa)}</div>
      <div id="mesa-pager">${pagerHtml(slice.page, slice.pages)}</div>
    </div>
    ${soloFooter("go-summary", "Ver resumen", !mesa.length || isSendLocked())}
    ${fabBlock()}
  </div>`);
  startCamHere();
  ensureWorkers();
}

function scanView() {
  show(state.scanMode === "sup" ? "supervisor" : "home");
}

function registerView(parsed) {
  render(`<div class="shell">
    ${appBar({ title: "Persona nueva", sub: "Ingresa el primer apellido", back: "home", progress: 25 })}
    <div class="scroll">
      ${speakBar()}
      ${blockCard("Datos de la persona", "Complete los campos obligatorios.")}
      <div class="field" id="fId"><label>Código</label><input id="regId" value="${esc(parsed.id || "")}" /><span class="hint">Campo obligatorio</span></div>
      <div class="field" id="fAp"><label>Primer apellido</label><input id="regAp" value="${esc(parsed.apellido || "")}" autocapitalize="characters" /><span class="hint">Campo obligatorio</span></div>
      <div class="field"><label>Nombre</label><input id="regNo" value="${esc(parsed.nombre || "")}" /></div>
      <div class="field"><label>Área</label><input id="regAr" value="${esc(parsed.area || "")}" /></div>
    </div>
    <footer class="footer">
      <button class="btn" data-act="save-reg" type="button">Guardar</button>
      <div style="height:8px"></div>
      <button class="btn ghost" data-act="home" type="button">Cancelar</button>
    </footer>
  </div>`);
}

function orderView() {
  show("home");
}

function summaryView() {
  show("home");
  showSummaryModal();
}

function dayView() {
  show("home");
  showSummaryModal();
}

function listaView() {
  const recs = recordsOfToday(TZ).filter((r) => r.type === "pedido" || r.type === "especial");
  const byW = new Map();
  for (const r of recs) {
    const id = r.payload?.trabajador_id;
    if (!id) continue;
    if (!byW.has(id)) byW.set(id, r);
  }
  const rows = [...byW.values()];
  const list = rows.map((r) => `<div class="list-item">
    <div>
      <b>${esc(r.payload.trabajador_apellido)}</b>
      <div class="meta">DNI ${esc(r.payload.trabajador_id || "")} · ${esc(r.payload.trabajador_nombre || "")}</div>
    </div>
    <span class="chip">OK</span>
  </div>`).join("") || `<p class="sub">Escanea supervisores para armar el resumen.</p>`;
  render(`<div class="shell">
    ${appBar({ title: "Quién pidió", sub: `${rows.length} personas hoy`, back: "home", progress: 70 })}
    <div class="scroll">
      ${list}
    </div>
    <footer class="footer">
      <button class="btn" data-act="send-lista" type="button" ${rows.length ? "" : "disabled"}>Enviar lista</button>
      <div style="height:8px"></div>
      <button class="btn ghost" data-act="home" type="button">Volver</button>
    </footer>
  </div>`);
}

function cierreView() {
  const calc = computeHeadcount(recordsOfToday(TZ));
  render(`<div class="shell">
    ${appBar({ title: "Cierre de cocina", sub: "Resumen del turno", back: "home", progress: 90 })}
    <div class="scroll">
      ${blockCard("Cierre", "Total de supervisores escaneados hoy.", `<div class="count-hero">
          <b>${calc.trabajadores_unicos}</b>
          <span>${calc.trabajadores_unicos === 1 ? "escaneado" : "escaneados"}</span>
        </div>`, "", "block-hero")}
      <div class="stats">
        <div class="stat"><em>Enviados</em><b>${calc.pedidos_enviados}</b></div>
        <div class="stat"><em>Aquí</em><b>${calc.pedidos_pendientes}</b></div>
      </div>
      ${calc.hasData ? "" : `<div class="note">Aún no hay registros.</div>`}
      <div class="field"><label>Comentario de cierre</label><textarea id="cierreCom"></textarea></div>
    </div>
    <footer class="footer">
      <button class="btn leaf" data-act="save-cierre" type="button">Guardar cierre</button>
      <div style="height:8px"></div>
      <button class="btn ghost" data-act="home" type="button">Volver</button>
    </footer>
  </div>`);
}

function syncView() {
  const n = pendingCount();
  render(`<div class="shell">
    ${appBar({ title: n ? "Por enviar" : "Todo enviado", sub: "Sync seguro" })}
    <div class="scroll">
      <p class="hello">${n ? "Por enviar" : "Todo enviado"}</p>
      <p class="sub">${state.online
        ? (n ? "Hay señal. Toca enviar." : "No queda nada pendiente.")
        : "Sin señal. Los pedidos están guardados en este celular."}</p>
      ${speakBar()}
      <div class="stat"><em>Pendientes</em><b>${n}</b></div>
    </div>
    <footer class="footer">
      <button class="btn leaf" data-act="do-sync" type="button" ${n ? "" : "disabled"}>Enviar ahora</button>
      <div style="height:8px"></div>
      <button class="btn ghost" data-act="home" type="button">Volver</button>
    </footer>
  </div>`);
}

function moreView() {
  const prefs = store.getPrefs();
  const admin = state.admin ? `<div class="admin">
      <div class="field"><label>Conexión</label>
        <input id="scriptUrl" value="${esc(store.getScriptUrl())}" placeholder="Pegar enlace" />
      </div>
      <div class="field"><label>Personas del turno</label>
        <input id="headcount" type="number" inputmode="numeric" value="${expectedHeadcount()}" />
      </div>
      <div class="grid-actions">
        <button class="card" data-act="save-settings" type="button"><h3>Guardar conexión</h3><p>Solo para quien arma la app.</p></button>
        <a class="card" href="./setup.html"><h3>Imprimir códigos</h3><p>Credenciales.</p></a>
        <button class="card" data-act="clear-cache" type="button"><h3>Limpiar app</h3><p>No borra pedidos guardados.</p></button>
      </div>
    </div>` : "";
  render(`<div class="shell">
    ${appBar({ title: "Menú", sub: "Ajustes del turno" })}
    <div class="scroll">
      ${speakBar()}
      <div class="grid-actions">
        <button class="card" data-act="toggle-voice" type="button">
          <h3>La app habla: ${prefs.voice === false ? "apagada" : "encendida"}</h3>
          <p>Un toque para prender o apagar.</p>
        </button>
        <button class="card" data-act="ask-logout" type="button">
          <h3>Cerrar turno</h3>
          <p>Se borran los DNI guardados en este celular.</p>
        </button>
      </div>
      ${admin}
    </div>
    <footer class="footer">
      <button class="btn ghost" data-act="home" type="button">Volver</button>
    </footer>
  </div>`);
}

function workerRows(query) {
  const q = (query || "").trim().toUpperCase();
  const rec = store.getRecientes();
  const all = [...rec, ...state.workers].filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i);
  const filtered = q
    ? all.filter((w) => `${w.apellido} ${w.nombre} ${w.nombreCompleto || ""} ${w.dni || w.id}`.toUpperCase().includes(q)).slice(0, 40)
    : rec.slice(0, 20);
  return filtered.map((w) => `<button class="list-item" data-act="pick-w" data-id="${esc(w.id)}" type="button">
    <div><b>${esc(twoApellidos(w))}</b><div class="meta">DNI ${esc(w.dni || w.id)} · ${esc(nameParts(w).nombre || "")}</div></div>
  </button>`).join("") || `<p class="sub">${q ? "Nadie coincide." : "Escanea el DNI o busca el apellido."}</p>`;
}

function supervisorRows(query) {
  const q = (query || "").trim().toUpperCase();
  const all = state.supervisors.filter((s, i, a) => a.findIndex((x) => x.id === s.id) === i);
  const rows = (q ? all.filter((s) => `${s.apellido} ${s.nombre} ${s.id}`.toUpperCase().includes(q)) : all);
  return rows.map((s) => `<button class="list-item" data-act="pick-s" data-id="${esc(s.id)}" type="button">
      <div><b>${esc(s.apellido)}</b><div class="meta">${esc(s.nombre || "")}</div></div>
    </button>`).join("") || `<p class="sub">Nadie coincide.</p>`;
}

function pickSupervisorView() {
  const rows = supervisorRows(state.pickQuery);
  render(`<div class="shell">
    ${appBar({ title: "Supervisor", sub: "Entrar al turno", back: "back-welcome" })}
    <div class="scroll">
      <div class="field"><label>Buscar</label>
        <input id="pickQ" value="${esc(state.pickQuery || "")}" placeholder="Apellido" />
      </div>
      <div id="pickList">${rows}</div>
    </div>
    <footer class="footer">
      <button class="btn ghost" data-act="cancel-scan" type="button">Volver</button>
    </footer>
  </div>`);
}

function pickWorkerView(next) {
  state.pickNext = next;
  render(`<div class="shell">
    ${appBar({ title: "¿Quién es?", sub: "Toca el apellido", back: "home", progress: 40 })}
    <div class="scroll">
      <div class="field"><label>Buscar</label>
        <input id="pickQ" value="${esc(state.pickQuery || "")}" placeholder="Apellido o código" />
      </div>
      <div id="pickList">${workerRows(state.pickQuery)}</div>
    </div>
    ${footer("home", `<button class="btn ghost" data-act="home" type="button">Volver</button><div style="height:8px"></div>`)}
  </div>`);
}

const ROUTES = [
  "welcome", "lock", "supervisor", "home", "register", "order",
  "summary", "dia", "lista", "cierre", "sync", "mas", "pick",
];

function viewFromHash() {
  const name = (location.hash || "").replace(/^#\/?/, "").split(/[/?#]/)[0];
  return ROUTES.includes(name) ? name : "";
}

function guardView(view) {
  if (!isFieldDevice()) return "lock";
  if (view === "lock") return "welcome";
  if (view === "scan" || view === "picksup" || view === "order" || view === "dia") return supervisor() ? "home" : "supervisor";
  if (!supervisor() && view !== "welcome" && view !== "supervisor") return "supervisor";
  return ROUTES.includes(view) ? view : "welcome";
}

function show(view, opts = {}) {
  const safe = guardView(view);
  const hash = `#/${safe}`;
  if (!opts.silent && location.hash !== hash) {
    if (opts.replace || state.view === "boot") history.replaceState({ view: safe }, "", hash);
    else history.pushState({ view: safe }, "", hash);
  }
  state.view = safe;
  if (safe !== "home" && safe !== "supervisor") scanner.stop();
  const map = {
    welcome: welcomeView,
    lock: lockView,
    supervisor: supervisorView,
    home: homeView,
    register: () => registerView(state.pendingParse || {}),
    order: orderView,
    summary: summaryView,
    dia: dayView,
    lista: listaView,
    cierre: cierreView,
    sync: syncView,
    mas: moreView,
    pick: () => pickWorkerView(state.pickNext),
  };
  (map[safe] || welcomeView)();
}

function syncFromUrl() {
  const view = viewFromHash() || "welcome";
  if (view === state.view) return;
  show(view, { silent: true });
}

function persistDraft() {
  grabFields();
  if (state.draft.worker) {
    store.setDraft(`${state.formType}:${state.draft.worker.id}`, state.draft);
  }
}

function grabFields() {
  const c = document.getElementById("comentario");
  const d = document.getElementById("dieta");
  const a = document.getElementById("alergias");
  if (c) state.draft.comentario = c.value;
  if (d) state.draft.tipo_dieta = d.value;
  if (a) state.draft.alergias = a.value;
}

function scanPayload(worker) {
  const s = supervisor();
  const t = nowParts(TZ);
  return {
    fecha_local: t.fecha,
    hora_local: t.hora,
    timezone: TZ,
    supervisor_id: s?.dni || s?.id || "",
    supervisor_apellido: supervisorNombreCompleto(s) || s?.apellido || "",
    supervisor_apellido_nombre: supervisorNombreCompleto(s) || s?.apellido || "",
    trabajador_id: worker.dni || worker.id,
    trabajador_apellido: twoApellidos(worker),
    trabajador_nombre: nameParts(worker).nombre || worker.nombreCompleto || worker.nombre || "",
    area: worker.cargo || worker.area || "",
    tipo_formulario: "pedido",
    hizo_pedido: true,
    fundo: currentFundo(),
    comida: currentLote(),
    comedor: currentComedor(),
    platos_detalle: currentLote(),
  };
}

async function saveScanRecord(worker) {
  const id = worker.dni || worker.id;
  const day = todayKey(TZ);
  const existing = recordsOfToday(TZ).find((r) => (
    r.payload?.trabajador_id === id && r.type !== "cierre" && r.type !== "lista"
  ));
  if (existing) return { status: existing.status || "pendiente", record: existing, already: true };
  const result = await saveAndSync({
    clientId: `scan:${day}:${id}`,
    type: "pedido",
    payload: scanPayload(worker),
    createdAt: Date.now(),
  });
  return { ...result, already: false };
}

async function registerPerson(worker, { silent = false } = {}) {
  const onMesa = getMesa().find((p) => p.id === worker.dni);
  upsertMesa({
    id: worker.dni,
    apellido: twoApellidos(worker),
    nombre: nameParts(worker).nombre || worker.nombreCompleto || worker.nombre,
    cargo: worker.cargo || worker.area || "",
    temporal: !!worker.temporal,
    status: "lista",
    plato: "",
  });
  store.touchReciente({ ...worker, kind: "wrk" });
  rememberDni(worker);
  state.mesaPage = 1;
  const ap = twoApellidos(worker) || worker.apellido || "";
  if (!silent) speakApellido(ap);
  return { result: { status: "lista" }, already: !!onMesa };
}

async function onScan(raw) {
  const parsed = parseQr(raw);
  const dni = parsed?.dni || parsed?.id || "";
  if (state.scanMode === "wrk" && dni) {
    if (getMesa().some((p) => p.id === dni)) {
      if (!state.handlingScan && !state.scanQueue.length) {
        const ap = twoApellidos(findWorkerByDni(dni) || {}) || dni;
        showScanHit({
          dni,
          nombre: ap,
          cargo: "—",
          ok: false,
          note: "Ya está en la lista. Intenta con otro trabajador.",
        });
        speak("Ya está en la lista. Intenta con otro trabajador.");
      }
      return;
    }
    if (state.scanQueue.some((q) => normalizeDni(parseQr(q)?.dni || parseQr(q)?.id) === dni)) return;
  }
  state.scanQueue.push(raw);
  if (state.handlingScan) return;
  state.handlingScan = true;
  try {
    while (state.scanQueue.length) {
      await handleOneScan(state.scanQueue.shift());
    }
  } finally {
    state.handlingScan = false;
    refreshMesaUi();
  }
}

async function handleOneScan(raw) {
  if (state.loggingIn) return;
  if (state.scanMode === "sup" && alertIsOpen()) return;
  const parsed = parseQr(raw);
  const dni = parsed?.dni || parsed?.id || "";
  if (!parsed || !dni) {
    speak("Código no válido. Solo el DNI.");
    showScanHit({ dni: "—", nombre: "No se leyó un DNI", cargo: "—", ok: false, note: "Acerca de nuevo el código." });
    return;
  }
  if (state.scanMode === "sup") {
    const hit = findSupervisor(parsed);
    if (hit) {
      state.emergencyPending = false;
      showLoginGate(hit);
      return;
    }
    if (state.emergencyPending) {
      try { await ensureWorkers(); } catch { /* entra igual */ }
      const worker = findWorkerByDni(dni);
      enterEmergencySupervisor(worker || { dni, id: dni });
      return;
    }
    speak("No autorizado.");
    showScanHit({
      dni,
      nombre: "No autorizado",
      cargo: "No está en supervisores de cosecha",
      ok: false,
      note: "Ese DNI no está en la lista autorizada. Si es emergencia, use el botón rojo.",
    });
    return;
  }
  if (isSendLocked()) {
    warnLocked();
    return;
  }
  await ensureWorkers();
  const worker = findWorkerByDni(dni);
  if (!worker) {
    showScanHit({
      dni,
      nombre: "No está en la lista",
      cargo: "No figura en trabajadores",
      ok: false,
      note: "Ese DNI no está en trabajadores. Use el ícono si es temporal.",
    });
    speak("No está en la lista.");
    return;
  }
  if (getMesa().some((p) => p.id === worker.dni)) {
    if (state.scanQueue.length) return;
    const ap = twoApellidos(worker) || worker.apellido || "";
    showScanHit({
      dni: worker.dni,
      nombre: ap,
      cargo: [nameParts(worker).nombre, worker.cargo].filter(Boolean).join(" · "),
      ok: false,
      note: "Ya está en la lista. Intenta con otro trabajador.",
    });
    speak("Ya está en la lista. Intenta con otro trabajador.");
    return;
  }
  await registerPerson(worker);
  showScanHit({
    dni: worker.dni,
    nombre: twoApellidos(worker),
    cargo: [nameParts(worker).nombre, worker.cargo].filter(Boolean).join(" · "),
    ok: true,
    note: "Registrado. Siguiente.",
  });
}

async function sendLista() {
  if (state.busy) return;
  const s = supervisor();
  if (!s) {
    speak("Vuelve a escanear tu DNI");
    show("supervisor");
    return;
  }
  if (isSendLocked()) {
    warnLocked();
    return;
  }
  const extra = !!state.extraOn;
  const mesa = getMesa();
  if (!mesa.length) {
    speak("Nadie en el resumen");
    return;
  }
  const t = nowParts(TZ);
  const comida = currentLote();
  const existing = extra ? null : store.getCola().find((r) => r.type === "lista" && !r.payload?.extra && r.payload?.comida === comida);
  const sendId = extra ? uuid() : (existing?.payload?.send_id || existing?.payload?.lote_lista_id || uuid());
  const n = mesa.length;
  const record = {
    clientId: extra ? `extra:${t.fecha}:${sendId}` : (existing?.clientId || `lista:${t.fecha}:${sendId}`),
    type: extra ? "extra" : "lista",
    payload: {
      fecha_local: t.fecha,
      hora_local: t.hora,
      timezone: TZ,
      supervisor_id: s.dni || s.id,
      supervisor_apellido: supervisorNombreCompleto(s),
      supervisor_apellido_nombre: supervisorNombreCompleto(s),
      hizo_pedido: true,
      extra,
      trabajadores_unicos: n,
      fundo: currentFundo(),
      comida,
      comedor: currentComedor(),
      send_id: sendId,
      personas: mesa.map((p) => ({
        id: p.id,
        dni: p.id,
        apellido: p.apellido || "",
        nombre: p.nombre || "",
        area: p.cargo || p.area || "",
      })),
    },
    createdAt: extra ? Date.now() : (existing?.createdAt || Date.now()),
  };
  store.upsertCola(record);
  setMesa(mesa.map((p) => ({ ...p, status: "lista" })));
  for (const p of mesa) rememberDni(p);
  if (extra) state.extraOn = false;
  dismissAlert();
  refreshPendPill();
  if (state.view === "home") refreshHomeLock();
  else show("home");
  const online = navigator.onLine;
  speak(extra
    ? (online ? `Extra: ${n} ${mealWord(comida, n)} al ${currentComedor()}` : `Sin señal. Extra de ${n} quedó en cola.`)
    : (online ? `Se pidió ${n} ${mealWord(comida, n)} al ${currentComedor()}` : `Sin señal. Quedó en cola. Al tener internet se sube solo.`));
  saveAndSync(record).then((result) => {
    if (result.status === "enviado") {
      setMesa(getMesa().map((p) => ({ ...p, status: "enviado" })));
    }
    refreshPendPill();
    if (state.view === "home") refreshHomeLock();
    if (!extra && result.duplicate) {
      speak("Ya se envió desde otro celular");
      showAlert(
        "Ya envió",
        "Este supervisor ya mandó el almuerzo de hoy desde otro celular. Si falta alguien, pulse Extra."
      );
    }
  });
}

async function saveCierre() {
  const s = supervisor();
  if (!s) {
    speak("Vuelve a escanear tu DNI");
    show("supervisor");
    return;
  }
  const calc = computeHeadcount(recordsOfToday(TZ));
  const t = nowParts(TZ);
  const comentario = document.getElementById("cierreCom")?.value || "";
  const result = await saveAndSync({
    clientId: uuid(),
    type: "cierre",
    payload: {
      fecha_local: t.fecha,
      hora_local: t.hora,
      timezone: TZ,
      supervisor_id: s.dni || s.id,
      supervisor_apellido: supervisorNombreCompleto(s),
      supervisor_apellido_nombre: supervisorNombreCompleto(s),
      trabajadores_unicos: calc.trabajadores_unicos,
      pedidos_enviados: calc.pedidos_enviados,
      pedidos_pendientes: calc.pedidos_pendientes,
      comentario,
    },
    createdAt: Date.now(),
  });
  speak(result.status === "enviado" ? "Cierre listo" : "Cierre guardado");
  show("summary");
}

async function doSync() {
  if (!store.getScriptUrl()) {
    speak("Aún no se puede enviar. Pide ayuda a oficina.");
    show("sync");
    return;
  }
  const sum = await flushQueue();
  if (sum.sent && !sum.pending) speak("Todo enviado");
  else if (sum.pending) speak(`Quedan ${sum.pending} por enviar`);
  else speak("Nada pendiente");
  show("sync");
}

async function clearAppCache() {
  store.clearDraftsOnly();
  await runAppUpdate("Borrando caché");
}

let tapLock = false;

async function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  if (btn.disabled || btn.getAttribute("disabled") !== null) return;
  unlockVoice();
  const act = btn.dataset.act;
  if (act === "stay") {
    if (!e.target.closest(".pick")) closePicks();
    e.stopPropagation();
    return;
  }
  const once = ["send-lista", "reload-app", "clear-cache", "logout", "drop-mesa", "save-temp-person", "add-emergency-sup", "confirm-emergency", "enter"];
  if (once.includes(act)) {
    if (tapLock) return;
    tapLock = true;
    window.setTimeout(() => { tapLock = false; }, 700);
  }
  if (act === "tab") {
    state.tab = btn.dataset.id;
    if (btn.dataset.id === "home") {
      if (!supervisor()) show("supervisor");
      else show("home");
      return;
    }
    if (btn.dataset.id === "sync") {
      show("sync");
      doSync();
      return;
    }
    show(btn.dataset.id);
    return;
  }
  if (act === "dismiss-alert") {
    dismissAlert();
    if (state.view === "supervisor") resumeCam();
    return;
  }
  if (act === "start-cam") { unlockVoice(); startCamHere(); return; }
  if (act === "stop-cam") { scanner.stop(); return; }
  if (act === "enter") { enterApp(); return; }
  if (act === "install-app") { installApp(); return; }
  if (act === "scan-sup") { goScan("sup"); return; }
  if (act === "scan-wrk") { goScan("wrk"); return; }
  if (act === "back-welcome") {
    state.entered = false;
    state.emergencyPending = false;
    show("welcome");
    return;
  }
  if (act === "cancel-scan") {
    if (state.scanMode === "sup") {
      state.entered = false;
      state.emergencyPending = false;
      show("welcome");
    } else show("home");
    return;
  }
  if (act === "home") {
    if (!supervisor()) show("supervisor");
    else show("home");
    return;
  }
  if (act === "toggle-fab") {
    const menu = document.getElementById("fab-menu");
    const btn = document.getElementById("fab-options-btn");
    if (!menu) return;
    menu.hidden = !menu.hidden;
    btn?.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
    return;
  }
  if (act === "go-historial") {
    state.histPage = 1;
    state.histOpen = "";
    state.histPeoplePage = 1;
    state.histPeopleQuery = "";
    showHistorialModal();
    return;
  }
  if (act === "toggle-hist") {
    const id = btn.dataset.id || "";
    if (state.histOpen === id) {
      state.histOpen = "";
      state.histPeopleQuery = "";
    } else {
      state.histOpen = id;
      state.histPeoplePage = 1;
      state.histPeopleQuery = "";
    }
    showHistorialModal();
    return;
  }
  if (act === "hist-page-prev") {
    state.histPage = Math.max(1, (state.histPage || 1) - 1);
    state.histOpen = "";
    showHistorialModal();
    return;
  }
  if (act === "hist-page-next") {
    state.histPage = (state.histPage || 1) + 1;
    state.histOpen = "";
    showHistorialModal();
    return;
  }
  if (act === "hist-people-prev") {
    state.histPeoplePage = Math.max(1, (state.histPeoplePage || 1) - 1);
    showHistorialModal();
    return;
  }
  if (act === "hist-people-next") {
    state.histPeoplePage = (state.histPeoplePage || 1) + 1;
    showHistorialModal();
    return;
  }
  if (act === "go-dni") {
    if (isSendLocked()) { warnLocked(); return; }
    state.dniPage = 1;
    state.dniQuery = "";
    state.dniSelected = {};
    showDniModal();
    return;
  }
  if (act === "dni-page-prev") {
    state.dniPage = Math.max(1, (state.dniPage || 1) - 1);
    showDniModal();
    return;
  }
  if (act === "dni-page-next") {
    state.dniPage = (state.dniPage || 1) + 1;
    showDniModal();
    return;
  }
  if (act === "toggle-dni") {
    const id = btn.dataset.id;
    if (!id) return;
    state.dniSelected = state.dniSelected || {};
    if (state.dniSelected[id]) delete state.dniSelected[id];
    else state.dniSelected[id] = true;
    showDniModal();
    focusDniSearch();
    return;
  }
  if (act === "toggle-dni-all") {
    const ids = filteredDniGuardados().map((p) => p.id).filter(Boolean);
    const every = ids.length > 0 && ids.every((id) => state.dniSelected[id]);
    state.dniSelected = state.dniSelected || {};
    if (every) {
      for (const id of ids) delete state.dniSelected[id];
    } else {
      for (const id of ids) state.dniSelected[id] = true;
    }
    showDniModal();
    focusDniSearch();
    return;
  }
  if (act === "use-saved-dnis") {
    if (isSendLocked()) { warnLocked(); return; }
    const ids = dniSelectedIds();
    if (!ids.length) return;
    let added = 0;
    for (const id of ids) {
      const worker = personFromSaved(id);
      if (!worker) continue;
      const { already } = await registerPerson(worker);
      if (!already) added += 1;
    }
    refreshMesaUi();
    dismissAlert();
    const n = added || ids.length;
    if (!added) speak("Ya estaban en la lista", { flush: true });
    return;
  }
  if (act === "use-saved-dni") {
    const worker = personFromSaved(btn.dataset.id);
    if (!worker) {
      showAlert("No encontrado", "Ese DNI no está guardado.");
      return;
    }
    registerPerson(worker).then(({ already }) => {
      refreshMesaUi();
      showDniModal();
      if (already) setScanLive("Ya está en el resumen.", true);
      else setScanLive(`${twoApellidos(worker)} · en lista`, true);
    });
    return;
  }
  if (act === "go-perfil") { showPerfilModal(); return; }
  if (act === "do-update") { showUpdateModal(); return; }
  if (act === "reload-app") {
    runAppUpdate();
    return;
  }
  if (act === "add-emergency-sup") {
    toggleEmergencySup();
    return;
  }
  if (act === "confirm-emergency") {
    dismissAlert();
    resumeCam();
    speak("Ten cuidado, por favor. Escanea tu QR.", { flush: true });
    return;
  }
  if (act === "add-temp-person") {
    if (isSendLocked()) { warnLocked(); return; }
    showTempPersonModal();
    return;
  }
  if (act === "save-temp-person") {
    const dni = normalizeDni(document.getElementById("tempDni")?.value || "");
    const nombre = String(document.getElementById("tempNombre")?.value || "").replace(/\s+/g, " ").trim();
    document.getElementById("fTempDni")?.classList.toggle("bad", !/^\d{8}$/.test(dni));
    document.getElementById("fTempNom")?.classList.toggle("bad", !nombre);
    if (!/^\d{8}$/.test(dni) || !nombre) {
      speak("Falta DNI o nombre.");
      return;
    }
    const official = findOfficial(dni);
    const parsed = nameParts({ nombreCompleto: nombre });
    const worker = official || {
      dni,
      id: dni,
      apellido: parsed.apellido,
      nombre: parsed.nombre,
      nombreCompleto: parsed.nombreCompleto,
      cargo: "Temporal",
      temporal: true,
    };
    registerPerson(worker).then(({ already }) => {
      dismissAlert();
      refreshMesaUi();
      setScanLive(already ? "Ya está en el resumen." : "Temporal. Guardado en este celular.", true);
    });
    return;
  }
  if (act === "ask-drop-mesa") {
    askDropMesa(btn.dataset.id, btn.dataset.name);
    return;
  }
  if (act === "drop-mesa") {
    const id = btn.dataset.id;
    const who = getMesa().find((p) => p.id === id);
    removeMesaPerson(id);
    dismissAlert();
    refreshMesaUi();
    speak(who ? `Quité a ${who.apellido || twoApellidos(who)}.` : "Quitado de la lista.");
    return;
  }
  if (act === "go-summary") {
    if (isSendLocked()) { warnLocked(); return; }
    showSummaryModal();
    return;
  }
  if (act === "toggle-extra" || act === "ask-extra" || act === "confirm-extra") {
    toggleExtra();
    return;
  }
  if (act === "pick-open") {
    e.stopPropagation();
    const wrap = btn.closest(".pick");
    if (!wrap) return;
    const wasOpen = wrap.classList.contains("open");
    closePicks();
    if (wasOpen) return;
    wrap.classList.add("open");
    const panel = wrap.querySelector(".pick-panel");
    if (panel) panel.hidden = false;
    return;
  }
  if (act === "pick-opt") {
    e.stopPropagation();
    const pick = btn.dataset.pick;
    const id = btn.dataset.id;
    const lab = btn.dataset.label || btn.textContent.trim();
    if (pick === "sel-fundo" || pick === "sel-etapa") store.setPrefs({ fundo: id, etapa: id });
    if (pick === "sel-comedor") store.setPrefs({ comedor: id });
    const wrap = btn.closest(".pick");
    if (wrap) {
      wrap.dataset.value = id;
      const valueEl = wrap.querySelector(".pick-value");
      if (valueEl) valueEl.textContent = lab;
      wrap.querySelectorAll(".pick-opt").forEach((opt) => {
        opt.classList.toggle("on", opt.dataset.id === id);
      });
    }
    closePicks();
    return;
  }
  if (act === "set-lote") {
    store.setPrefs({ lote: "Almuerzo" });
    if (state.extraOn) {
      toggleExtra();
      return;
    }
    if (document.querySelector(".summary-modal")) {
      showSummaryModal();
      return;
    }
    return;
  }
  if (act === "set-comedor") {
    const name = btn.dataset.id;
    if (!comedores().includes(name)) return;
    store.setPrefs({ comedor: name });
    if (document.querySelector(".summary-modal")) showSummaryModal();
    return;
  }
  if (act === "page-prev") {
    state.mesaPage = Math.max(1, (state.mesaPage || 1) - 1);
    refreshMesaUi();
    return;
  }
  if (act === "page-next") {
    state.mesaPage = (state.mesaPage || 1) + 1;
    refreshMesaUi();
    return;
  }
  if (act === "go-lista") { show("lista"); return; }
  if (act === "go-cierre") { show("cierre"); return; }
  if (act === "logo-tap") {
    state.logoTaps = (state.logoTaps || 0) + 1;
    clearTimeout(state.logoTimer);
    state.logoTimer = setTimeout(() => { state.logoTaps = 0; }, 2200);
    if (state.logoTaps >= 7) {
      state.logoTaps = 0;
      state.admin = !state.admin;
      speak(state.admin ? "Ajustes" : "Listo");
      show("mas");
    }
    return;
  }
  if (act === "go-pick") {
    if (state.scanMode === "sup" || !supervisor()) return;
    state.formType = "pedido";
    show("pick");
    return;
  }
  if (act === "go-especial-pick") { show("pick"); return; }
  if (act === "manual-sup" || act === "manual-code") {
    const raw = prompt("Código o QR en texto");
    if (raw) onScan(raw);
    return;
  }
  if (act === "send-lista") { sendLista(); return; }
  if (act === "save-cierre") { saveCierre(); return; }
  if (act === "do-sync") { doSync(); return; }
  if (act === "ping") {
    pingServer().then((r) => speak(r.ok ? `Servidor en ${r.version || "línea"}` : "Sin servidor"));
    return;
  }
  if (act === "toggle-voice") {
    setVoiceEnabled(!voiceEnabled());
    speak(voiceEnabled() ? "La app habla" : "Voz apagada");
    show("mas");
    return;
  }
  if (act === "save-settings") {
    const url = document.getElementById("scriptUrl")?.value || "";
    const hc = document.getElementById("headcount")?.value || "";
    store.setScriptUrl(url);
    store.setPrefs({ headcount: Number(hc) || expectedHeadcount() });
    speak("Ajustes guardados");
    show("mas");
    return;
  }
  if (act === "clear-cache") { clearAppCache(); return; }
  if (act === "ask-logout") { showLogoutWarn(); return; }
  if (act === "logout") {
    dismissAlert();
    closeFab();
    store.clearDniGuardados();
    store.clearRecientes();
    store.clearMesa();
    store.clearSesion();
    store.clearTurnoDia();
    state.emergencyPending = false;
    state.extraOn = false;
    speak("Turno cerrado. Se borraron los DNI guardados.");
    show("supervisor");
    return;
  }
  if (act === "save-reg") {
    const person = {
      id: document.getElementById("regId").value.trim(),
      apellido: document.getElementById("regAp").value.trim().toUpperCase(),
      nombre: document.getElementById("regNo").value.trim(),
      area: document.getElementById("regAr").value.trim(),
    };
    const oficial = findOfficial(person.id);
    if (!oficial) {
      document.getElementById("fId")?.classList.add("bad");
      showAlert("No está en la lista", "Ese DNI no está en trabajadores.");
      return;
    }
    registerPerson(oficial).then(() => show("home"));
    return;
  }
  if (act === "pick-w") {
    const w = findOfficial(btn.dataset.id);
    if (!w) {
      showAlert("No está en la lista", "Solo supervisores de cosecha pueden pedir almuerzo.");
      return;
    }
    registerPerson(w).then(() => show("home"));
  }
}

async function boot() {
  stripUpdateQuery();
  state.swGuardUntil = Date.now() + 12000;
  bindInstallPrompt();
  bindAppHeight();
  bindFieldLock((ok) => {
    if (!ok) {
      if (state.view !== "lock") show("lock", { replace: true });
      return;
    }
    if (state.view === "lock") {
      show(supervisor() ? "home" : "welcome", { replace: true });
    }
  });
  onVoiceState((on, phrase) => {
    state.lastSpeak = on ? phrase : "";
    const el = document.getElementById("speakbar");
    if (!el) return;
    el.classList.toggle("on", on);
    const span = el.querySelector("span");
    if (span) span.textContent = phrase || "";
  });
  document.getElementById("app").addEventListener("click", onClick);
  document.getElementById("app").addEventListener("input", (e) => {
    if (e.target.id === "pickQ") {
      state.pickQuery = e.target.value;
      const list = document.getElementById("pickList");
      if (!list) return;
      list.innerHTML = state.view === "picksup" ? supervisorRows(state.pickQuery) : workerRows(state.pickQuery);
    }
    if (e.target.id === "comentario" || e.target.id === "dieta" || e.target.id === "alergias") {
      grabFields();
      persistDraft();
    }
  });
  window.addEventListener("online", () => {
    state.online = true;
    flushQueue().then((s) => {
      if (s?.duplicates) speak("Hoy ya envió. Solo extra.");
      else if (s?.sent) speak(`Se enviaron ${s.sent} pendientes`);
      refreshPendPill();
      refreshHomeLock();
      if (supervisor()) syncTurnoDelDia().then(() => refreshHomeLock());
    });
  });
  window.addEventListener("offline", () => {
    state.online = false;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      state.online = navigator.onLine;
      store.restoreSesion().then(() => {
        if (state.view !== "welcome" && state.view !== "supervisor" && state.view !== "lock" && !supervisor()) {
          show("supervisor", { replace: true });
          return;
        }
        flushQueue().then(() => refreshPendPill());
        if (supervisor()) syncTurnoDelDia().then(() => refreshHomeLock());
      });
    }
  });
  window.addEventListener("pageshow", () => {
    state.online = navigator.onLine;
    store.restoreSesion().then(() => {
      flushQueue().then(() => refreshPendPill());
      if (supervisor()) syncTurnoDelDia().then(() => refreshHomeLock());
    });
  });
  window.addEventListener("popstate", syncFromUrl);
  window.addEventListener("hashchange", syncFromUrl);

  const catalogs = Promise.all([
    loadJson("./data/config.json", {}),
    loadJson("./data/supervisors.json", { supervisores: [] }),
  ]);

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
    } catch { /* offline first run */ }
    watchAppUpdates();
  }

  const [cfg, sup] = await catalogs;
  state.cfg = cfg;
  state.menu = null;
  state.items = [];
  state.lotes = [];

  state.supByDni = new Map();
  const byDni = sup.byDni && typeof sup.byDni === "object" ? sup.byDni : {};
  for (const [dni, row] of Object.entries(byDni)) {
    const person = mapTrabajador({ dni, nombre: row.nombre, cargo: row.cargo || "SUPERVISOR DE COSECHA" });
    if (!person.dni) continue;
    state.supByDni.set(person.dni, {
      ...person,
      celular: row.celular || "",
      supervisorGlobal: row.supervisorGlobal || "",
      encargadoDni: row.encargadoDni || "",
    });
  }
  if (!state.supByDni.size && Array.isArray(sup.supervisores)) {
    for (const row of sup.supervisores) {
      const person = mapTrabajador(row);
      if (person.dni) state.supByDni.set(person.dni, person);
    }
  }
  state.supervisors = [...state.supByDni.values()];
  state.oficial = state.supByDni;
  state.workers = [];
  if (cfg.appsScriptUrl) store.setScriptUrl(cfg.appsScriptUrl);
  dropScanCola();

  await store.restoreSesion();
  const hash = viewFromHash();
  const wasUpdating = (() => {
    try { return !!sessionStorage.getItem("qb_updating"); } catch { return false; }
  })();
  if (supervisor()) {
    store.setSesion(supervisor());
    const next = hash && hash !== "welcome" && hash !== "lock" && hash !== "supervisor" ? hash : "home";
    show(next, { replace: true });
    if (state.online) {
      syncTurnoDelDia({ timeoutMs: 2200 }).then(() => refreshHomeLock());
      flushQueue().then(() => refreshPendPill());
    }
  } else {
    show(hash === "supervisor" ? "supervisor" : "welcome", { replace: true });
    if (state.view === "welcome" && !wasUpdating) speak("Bienvenido a Cocina Q Berries");
  }
  if (wasUpdating) hideUpdatingVeil();
}

function enterApp() {
  if (!isFieldDevice()) {
    show("lock", { replace: true });
    return;
  }
  if (state.view !== "welcome") return;
  state.entered = true;
  unlockVoice();
  if (!supervisor()) {
    speak("Escanea al supervisor");
    show("supervisor");
    return;
  }
  speak(`Bienvenido ${twoApellidos(supervisor())}`);
  show("home");
}

boot();

export { encodeQr };
