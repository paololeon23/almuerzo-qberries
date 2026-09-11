import { APP_VERSION, TZ, nowParts } from "./config.js";
import { store } from "./store.js";

const PING_TIMEOUT_MS = 10000;
const POST_TIMEOUT_MS = 45000;
const RETRY_MIN_MS = 4000;
const RETRY_MAX_MS = 25000;

let flushing = false;
let flushAgain = false;
let retryTimer = 0;
let retryDelay = RETRY_MIN_MS;
let autoBound = false;
let onFlushDone = null;

function markListaTurno(record, raw) {
  if (!record || record.type !== "lista" || record.payload?.extra) return;
  // Si el servidor dijo "ya enviado" pero no guardó a nadie, no bloquear el celular:
  // permite reintentar como almuerzo normal (evita forzar Extra con Lista 0).
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

function stampNow(payload = {}) {
  const t = nowParts(TZ);
  return {
    ...payload,
    fecha_local: t.fecha,
    hora_local: t.hora,
    timezone: TZ,
  };
}

function abortAfter(ms) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
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
  retryTimer = window.setTimeout(() => {
    retryTimer = 0;
    flushQueue().catch(() => {});
  }, retryDelay);
  retryDelay = Math.min(RETRY_MAX_MS, Math.round(retryDelay * 1.5));
}

function pingUrl(base) {
  const u = String(base || "").trim();
  if (!u) return "";
  const sep = u.includes("?") ? "&" : "?";
  return `${u}${sep}path=fundos`;
}

export async function canReachServer(url, timeoutMs = PING_TIMEOUT_MS) {
  const u = pingUrl(url || store.getScriptUrl());
  if (!u) return false;
  try {
    const res = await fetch(u, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: abortAfter(timeoutMs),
    });
    if (!res.ok) return false;
    const json = JSON.parse(await res.text());
    return !!(json && (json.ok === true || json.ping === true || Array.isArray(json.fundos)));
  } catch {
    return false;
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
    const res = await fetch(`${u}?${qs}`, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: abortAfter(timeoutMs || 8000),
    });
    return JSON.parse(await res.text());
  } catch (err) {
    return { ok: false, error: "sin_red", detail: String(err.message || err) };
  }
}

export async function pingServer(url) {
  const u = (url || store.getScriptUrl()).trim();
  if (!u) return { ok: false, error: "sin_url" };
  try {
    const res = await fetch(u, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: abortAfter(PING_TIMEOUT_MS),
    });
    const text = await res.text();
    return JSON.parse(text);
  } catch (err) {
    return { ok: false, error: "sin_red", detail: String(err.message || err) };
  }
}

export async function postRecord(record, url) {
  const u = (url || store.getScriptUrl()).trim();
  if (!u) throw new Error("sin_url");
  const stamped = { ...record, payload: stampNow(record.payload || {}) };
  store.upsertCola(stamped);
  const body = JSON.stringify({
    type: stamped.type,
    clientId: stamped.clientId,
    payload: stamped.payload,
    clientVersion: APP_VERSION,
  });
  const res = await fetch(u, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: abortAfter(POST_TIMEOUT_MS),
  });
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
  return { duplicate: !!json.duplicate, record: stamped, raw: json };
}

function isListaRecord(record) {
  return record?.type === "lista" && !record.payload?.extra;
}

function flushRank(record) {
  if (isListaRecord(record)) return 0;
  if (record?.type === "extra" || record?.payload?.extra) return 1;
  return 2;
}

function dropListaAsDuplicate(record, raw) {
  store.pushHistorial({ ...record, duplicate: true, confirmed: true });
  store.removeCola(record.clientId);
  markListaTurno(record, raw);
}

function confirmSent(result) {
  store.pushHistorial({ ...result.record, duplicate: result.duplicate, confirmed: true });
  store.removeCola(result.record.clientId);
  markListaTurno(result.record, result.raw);
}

export async function saveAndSync(record) {
  const queued = { ...record, payload: stampNow(record.payload || {}) };
  store.upsertCola(queued);
  scheduleRetry();
  try {
    const result = await postRecord(queued);
    confirmSent(result);
    return { status: "enviado", duplicate: result.duplicate, record: result.record, raw: result.raw };
  } catch {
    scheduleRetry();
    return { status: "pendiente", record: queued };
  }
}

export async function flushQueue(onEach) {
  const cola = pendingRecords();
  const summary = { sent: 0, pending: cola.length, duplicates: 0, errors: 0 };
  if (!cola.length) {
    clearRetry();
    retryDelay = RETRY_MIN_MS;
    return { ...summary, pending: 0 };
  }
  if (flushing) {
    flushAgain = true;
    return summary;
  }
  flushing = true;
  try {
    const reachable = await canReachServer();
    if (!reachable) {
      scheduleRetry();
      return { ...summary, pending: pendingRecords().length };
    }
    retryDelay = RETRY_MIN_MS;
    const ordered = [...pendingRecords()].sort((a, b) => flushRank(a) - flushRank(b));
    let fails = 0;
    let pass = 0;
    for (const record of ordered) {
      if (!stillQueued(record.clientId)) continue;
      if (pass) await new Promise((r) => setTimeout(r, 0));
      pass += 1;
      try {
        if (isListaRecord(record) && store.getTurnoDia()?.enviado) {
          dropListaAsDuplicate(record, { duplicate: true, already: true, trabajadores: 1 });
          summary.duplicates += 1;
          fails = 0;
          onEach?.({ ok: true, record, result: { duplicate: true, already: true } });
          continue;
        }
        const result = await postRecord(record);
        confirmSent(result);
        fails = 0;
        if (result.duplicate) summary.duplicates += 1;
        else summary.sent += 1;
        onEach?.({ ok: true, record: result.record, result: result.raw });
      } catch {
        summary.errors += 1;
        fails += 1;
        onEach?.({ ok: false, record });
        if (fails >= 3) break;
      }
    }
  } finally {
    flushing = false;
  }
  summary.pending = pendingRecords().length;
  if (summary.pending) scheduleRetry();
  else {
    clearRetry();
    retryDelay = RETRY_MIN_MS;
  }
  if (flushAgain) {
    flushAgain = false;
    if (summary.errors >= 3) {
      scheduleRetry();
    } else {
      const more = await flushQueue(onEach);
      return {
        sent: summary.sent + more.sent,
        pending: more.pending,
        duplicates: summary.duplicates + more.duplicates,
        errors: summary.errors + more.errors,
      };
    }
  }
  try { onFlushDone?.(summary); } catch { /* UI opcional */ }
  return summary;
}

export function startAutoSync(onDone) {
  if (typeof onDone === "function") onFlushDone = onDone;
  if (!autoBound) {
    autoBound = true;
    const kick = () => {
      scheduleRetry(true);
      flushQueue().catch(() => {});
    };
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    conn?.addEventListener("change", kick);
  }
  scheduleRetry(true);
  return flushQueue();
}
