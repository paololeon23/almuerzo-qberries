import { APP_VERSION, TZ, nowParts } from "./config.js";
import { store } from "./store.js";

const PING_TIMEOUT_MS = 10000;
const PROBE_MS = 4000;
const POST_TIMEOUT_MS = 45000;
const RETRY_MIN_MS = 4000;
const RETRY_MAX_MS = 25000;
const SLOW_TYPES = new Set(["slow-2g", "2g", "3g"]);

let flushWait = null;
let flushAgain = false;
let retryTimer = 0;
let retryDelay = RETRY_MIN_MS;
let autoBound = false;
let onFlushDone = null;
let linkWasOnline = true;
let linkWasSlow = false;
const inflight = new Map();

function netInfo() {
  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
}

export function isSlowLink() {
  const conn = netInfo();
  if (!conn) return false;
  const effective = String(conn.effectiveType || "").toLowerCase();
  if (SLOW_TYPES.has(effective)) return true;
  if (conn.saveData === true) return true;
  const down = Number(conn.downlink);
  if (Number.isFinite(down) && down > 0 && down <= 0.5) return true;
  const rtt = Number(conn.rtt);
  if (effective !== "4g" && Number.isFinite(rtt) && rtt >= 400) return true;
  return false;
}

function markListaTurno(record, raw) {
  if (!record || record.type !== "lista" || record.payload?.extra) return;
  if (raw && raw.duplicate && (raw.already || raw.error === "ya_enviado") && Number(raw.trabajadores || 0) === 0) {
    return;
  }
  const sid = String(record.payload?.supervisor_id || "").replace(/\D/g, "").slice(0, 8);
  store.setTurnoDia({
    dni: sid,
    fecha: record.payload?.fecha_local,
    comida: record.payload?.comida || "Almuerzo",
    enviado: true,
  });
}

function stampPayload(payload = {}) {
  const t = nowParts(TZ);
  return {
    ...payload,
    fecha_local: payload.fecha_local || t.fecha,
    hora_local: payload.hora_local || t.hora,
    timezone: payload.timezone || TZ,
  };
}

function pendingRecords() {
  return store.getCola().filter((r) => r.type === "lista" || r.type === "extra" || r.type === "cierre");
}

function stillQueued(clientId) {
  return pendingRecords().some((r) => r.clientId === clientId);
}

function clearRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = 0;
  }
}

function scheduleRetry(soon = false) {
  if (!pendingRecords().length) {
    clearRetry();
    retryDelay = RETRY_MIN_MS;
    return;
  }
  if (soon) {
    retryDelay = RETRY_MIN_MS;
    clearRetry();
  }
  if (retryTimer) return;
  const wait = retryDelay;
  retryTimer = setTimeout(() => {
    retryTimer = 0;
    flushQueue().catch(() => {});
  }, wait);
  retryDelay = Math.min(RETRY_MAX_MS, Math.round(retryDelay * 1.5));
}

function pingUrl(base) {
  const u = String(base || "").trim();
  if (!u) return "";
  const sep = u.includes("?") ? "&" : "?";
  return `${u}${sep}path=fundos`;
}

function isBrowserOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function isTransient(err) {
  const name = String(err?.name || "");
  const msg = String(err?.message || err || "");
  if (name === "AbortError" || msg === "sin_red") return true;
  if (msg === "Failed to fetch" || msg === "NetworkError" || msg === "Load failed") return true;
  if (msg === "lock_timeout" || msg === "http_408" || msg === "http_429") return true;
  return /^http_5\d\d$/.test(msg);
}

async function fetchText(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function canReachServer(url, timeoutMs = PING_TIMEOUT_MS) {
  const probe = await probeServer(url, timeoutMs);
  return probe === "ok";
}

async function probeServer(url, timeoutMs = PROBE_MS) {
  const u = pingUrl(url || store.getScriptUrl());
  if (!u || isBrowserOffline()) return "down";
  try {
    const res = await fetchText(u, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }, timeoutMs);
    if (!res.ok) return "down";
    const json = JSON.parse(await res.text());
    return json && (json.ok === true || json.ping === true || Array.isArray(json.fundos)) ? "ok" : "down";
  } catch (err) {
    return err?.name === "AbortError" ? "slow" : "down";
  }
}

export async function checkTurno({ supervisorId, fecha, comida, url, timeoutMs } = {}) {
  const u = (url || store.getScriptUrl()).trim();
  if (!u) return { ok: false, error: "sin_url" };
  const t = nowParts(TZ);
  const sid = String(supervisorId || "").replace(/\D/g, "").slice(0, 8);
  if (!/^\d{8}$/.test(sid)) return { ok: false, error: "sesion_invalida" };
  const qs = new URLSearchParams({
    path: "turno",
    supervisor: sid,
    fecha: fecha || t.fecha,
    comida: comida || "Almuerzo",
  });
  try {
    const res = await fetchText(`${u}?${qs}`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }, timeoutMs || 8000);
    return JSON.parse(await res.text());
  } catch (err) {
    return { ok: false, error: "sin_red", detail: String(err.message || err) };
  }
}

export async function pingServer(url) {
  const u = (url || store.getScriptUrl()).trim();
  if (!u) return { ok: false, error: "sin_url" };
  try {
    const res = await fetchText(u, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }, PING_TIMEOUT_MS);
    const text = await res.text();
    return JSON.parse(text);
  } catch (err) {
    return { ok: false, error: "sin_red", detail: String(err.message || err) };
  }
}

async function deliverRecord(record, url) {
  const u = (url || store.getScriptUrl()).trim();
  const stamped = { ...record, payload: stampPayload(record.payload || {}) };
  store.upsertCola(stamped);
  if (!u) throw new Error("sin_url");
  if (isBrowserOffline()) throw new Error("sin_red");
  const body = JSON.stringify({
    type: stamped.type,
    clientId: stamped.clientId,
    payload: stamped.payload,
    clientVersion: APP_VERSION,
  });
  const res = await fetchText(u, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  }, POST_TIMEOUT_MS);
  if (!res.ok) throw new Error(`http_${res.status}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("respuesta_invalida");
  }
  if (!json.ok) throw new Error(json.error || "servidor");
  const isExtra = stamped.type === "extra" || stamped.payload?.extra;
  if (isExtra && (json.error === "sin_almuerzo" || (json.extra === false && Number(json.trabajadores || 0) === 0))) {
    throw new Error("sin_almuerzo");
  }
  const confirmed = json.saved === true || json.duplicate === true
    || typeof json.total === "number" || typeof json.trabajadores === "number";
  if (!confirmed) throw new Error("sin_confirmacion");
  const result = { duplicate: !!json.duplicate, record: stamped, raw: json };
  confirmSent(result);
  return result;
}

export function postRecord(record, url) {
  const id = String(record?.clientId || "");
  if (id && inflight.has(id)) return inflight.get(id);
  const job = deliverRecord(record, url);
  if (id) {
    inflight.set(id, job);
    job.finally(() => {
      if (inflight.get(id) === job) inflight.delete(id);
    }).catch(() => {});
  }
  return job;
}

function isListaRecord(record) {
  return record?.type === "lista" && !record.payload?.extra;
}

function flushRank(record) {
  if (isListaRecord(record)) return 0;
  if (record?.type === "extra" || record?.payload?.extra) return 1;
  return 2;
}

function confirmSent(result) {
  store.pushHistorial({ ...result.record, duplicate: result.duplicate, confirmed: true });
  store.removeCola(result.record.clientId);
  markListaTurno(result.record, result.raw);
}

export async function saveAndSync(record) {
  const queued = { ...record, payload: stampPayload(record.payload || {}) };
  store.upsertCola(queued);
  scheduleRetry();
  if (isBrowserOffline()) return { status: "pendiente", record: queued };
  try {
    const result = await postRecord(queued);
    confirmSent(result);
    if (!pendingRecords().length) {
      clearRetry();
      retryDelay = RETRY_MIN_MS;
    }
    return { status: "enviado", duplicate: result.duplicate, record: result.record, raw: result.raw };
  } catch {
    scheduleRetry();
    return { status: "pendiente", record: queued };
  }
}

async function flushPass(onEach) {
  const summary = { sent: 0, duplicates: 0, errors: 0, skippedOffline: false };
  if (!pendingRecords().length) return summary;
  if (isBrowserOffline()) {
    summary.skippedOffline = true;
    return summary;
  }
  if (!isSlowLink()) {
    const probe = await probeServer();
    if (probe === "down") return summary;
  }
  const ordered = [...pendingRecords()].sort((a, b) => flushRank(a) - flushRank(b));
  let fails = 0;
  let pass = 0;
  for (const record of ordered) {
    if (!stillQueued(record.clientId)) continue;
    if (pass) await new Promise((r) => setTimeout(r, 0));
    pass += 1;
    try {
      const result = await postRecord(record);
      confirmSent(result);
      fails = 0;
      if (result.duplicate) summary.duplicates += 1;
      else summary.sent += 1;
      onEach?.({ ok: true, record: result.record, result: result.raw });
    } catch (err) {
      summary.errors += 1;
      fails += 1;
      onEach?.({ ok: false, record, error: err });
      if (isTransient(err) || fails >= 3) break;
    }
  }
  return summary;
}

async function flushBody(onEach) {
  let sent = 0;
  let duplicates = 0;
  let errors = 0;
  let guard = 0;
  while (guard++ < 4) {
    flushAgain = false;
    const pass = await flushPass(onEach);
    sent += pass.sent;
    duplicates += pass.duplicates;
    errors += pass.errors;
    const pending = pendingRecords().length;
    if (!pending) {
      clearRetry();
      retryDelay = RETRY_MIN_MS;
      return { sent, pending: 0, duplicates, errors };
    }
    const followNow = flushAgain && pass.errors === 0 && (pass.sent > 0 || (pass.skippedOffline && !isBrowserOffline()));
    if (followNow) continue;
    if (pass.sent > 0 && pass.errors === 0) retryDelay = RETRY_MIN_MS;
    scheduleRetry(pass.sent > 0 && pass.errors === 0);
    return { sent, pending, duplicates, errors };
  }
  scheduleRetry();
  return { sent, pending: pendingRecords().length, duplicates, errors };
}

export function flushQueue(onEach) {
  if (flushWait) {
    flushAgain = true;
    return flushWait;
  }
  const run = (async () => {
    try {
      return await flushBody(onEach);
    } finally {
      flushWait = null;
    }
  })();
  flushWait = run;
  return run.then((summary) => {
    try { onFlushDone?.(summary); } catch { /* UI opcional */ }
    return summary;
  });
}

function kickSync() {
  const online = !isBrowserOffline();
  const slow = isSlowLink();
  const becameUsable = online && (!linkWasOnline || (slow && !linkWasSlow));
  linkWasOnline = online;
  linkWasSlow = slow;
  if (!pendingRecords().length || !online) return;
  if (becameUsable) {
    scheduleRetry(true);
    flushQueue().catch(() => {});
    return;
  }
  if (!retryTimer) flushQueue().catch(() => {});
}

export function startAutoSync(onDone) {
  if (typeof onDone === "function") onFlushDone = onDone;
  if (!autoBound) {
    autoBound = true;
    linkWasOnline = !isBrowserOffline();
    linkWasSlow = isSlowLink();
    window.addEventListener("online", kickSync);
    window.addEventListener("offline", () => {
      linkWasOnline = false;
    });
    netInfo()?.addEventListener?.("change", kickSync);
  }
  scheduleRetry(true);
  return flushQueue();
}
