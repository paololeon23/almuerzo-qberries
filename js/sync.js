import { APP_VERSION, TZ, nowParts } from "./config.js";
import { store } from "./store.js";

let flushing = false;

function markListaTurno(record) {
  if (!record || record.type !== "lista" || record.payload?.extra) return;
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

export async function checkTurno({ supervisorId, fecha, comida, url } = {}) {
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

function isListaRecord(record) {
  return record?.type === "lista" && !record.payload?.extra;
}

function dropListaAsDuplicate(record) {
  store.pushHistorial({ ...record, duplicate: true, confirmed: true });
  store.removeCola(record.clientId);
  markListaTurno(record);
}

async function serverAlreadyHasLista(record) {
  const sid = String(record?.payload?.supervisor_id || store.getSesionDni() || "").replace(/\D/g, "").slice(0, 8);
  if (!/^\d{8}$/.test(sid)) return false;
  const t = await checkTurno({
    supervisorId: sid,
    fecha: record?.payload?.fecha_local,
    comida: record?.payload?.comida || "Almuerzo",
  });
  if (!t?.ok) return false;
  if (t.enviado) {
    store.setTurnoDia({
      dni: sid,
      fecha: t.fecha,
      comida: t.comida || "Almuerzo",
      enviado: true,
    });
    return true;
  }
  return false;
}

export async function saveAndSync(record) {
  const queued = { ...record, payload: stampNow(record.payload || {}) };
  store.upsertCola(queued);
  if (!navigator.onLine) {
    return { status: "pendiente", record: queued };
  }
  try {
    if (isListaRecord(queued) && await serverAlreadyHasLista(queued)) {
      dropListaAsDuplicate(queued);
      return { status: "enviado", duplicate: true, record: queued };
    }
    const result = await postRecord(queued);
    store.pushHistorial({ ...result.record, duplicate: result.duplicate, confirmed: true });
    store.removeCola(result.record.clientId);
    markListaTurno(result.record);
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
    const firstLista = cola.find(isListaRecord);
    if (firstLista && await serverAlreadyHasLista(firstLista)) {
      for (const record of cola.filter(isListaRecord)) {
        dropListaAsDuplicate(record);
        summary.duplicates += 1;
        onEach?.({ ok: true, record, result: { duplicate: true, already: true } });
      }
    }
    const rest = store.getCola().filter((r) => r.type === "lista" || r.type === "extra" || r.type === "cierre");
    for (const record of [...rest]) {
      try {
        if (isListaRecord(record) && store.getTurnoDia()?.enviado) {
          dropListaAsDuplicate(record);
          summary.duplicates += 1;
          onEach?.({ ok: true, record, result: { duplicate: true, already: true } });
          continue;
        }
        const result = await postRecord(record);
        store.pushHistorial({ ...result.record, duplicate: result.duplicate, confirmed: true });
        store.removeCola(result.record.clientId);
        markListaTurno(result.record);
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
