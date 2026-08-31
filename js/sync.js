import { APP_VERSION, TZ, nowParts } from "./config.js";
import { store } from "./store.js";

let flushing = false;

function stampNow(payload = {}) {
  const t = nowParts(TZ);
  return {
    ...payload,
    fecha_local: t.fecha,
    hora_local: t.hora,
    timezone: TZ,
  };
}

export async function pingServer(url) {
  const u = (url || store.getScriptUrl()).trim();
  if (!u) return { ok: false, error: "sin_url" };
  try {
    const res = await fetch(u, { method: "GET", cache: "no-store" });
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
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("respuesta_invalida");
  }
  if (!json.ok) throw new Error(json.error || "servidor");
  const confirmed = json.saved === true || json.duplicate === true
    || typeof json.total === "number" || typeof json.trabajadores === "number";
  if (!confirmed) throw new Error("sin_confirmacion");
  return { duplicate: !!json.duplicate, record: stamped, raw: json };
}

export async function saveAndSync(record) {
  const queued = { ...record, payload: stampNow(record.payload || {}) };
  store.upsertCola(queued);
  if (!navigator.onLine) {
    return { status: "pendiente", record: queued };
  }
  try {
    const result = await postRecord(queued);
    store.pushHistorial({ ...result.record, duplicate: result.duplicate, confirmed: true });
    store.removeCola(result.record.clientId);
    return { status: "enviado", duplicate: result.duplicate, record: result.record };
  } catch {
    return { status: "pendiente", record: queued };
  }
}

export async function flushQueue(onEach) {
  const cola = store.getCola().filter((r) => r.type === "lista" || r.type === "extra" || r.type === "cierre");
  const summary = { sent: 0, pending: 0, duplicates: 0, errors: 0 };
  if (flushing) {
    summary.pending = cola.length;
    return summary;
  }
  if (!navigator.onLine) {
    summary.pending = cola.length;
    return summary;
  }
  flushing = true;
  try {
    for (const record of [...cola]) {
      try {
        const result = await postRecord(record);
        store.pushHistorial({ ...result.record, duplicate: result.duplicate, confirmed: true });
        store.removeCola(result.record.clientId);
        if (result.duplicate) summary.duplicates += 1;
        else summary.sent += 1;
        onEach?.({ ok: true, record: result.record, result: result.raw });
      } catch {
        summary.pending += 1;
        summary.errors += 1;
        onEach?.({ ok: false, record });
      }
    }
  } finally {
    flushing = false;
  }
  return summary;
}
