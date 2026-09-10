import {
  STORAGE_KEYS,
  HISTORY_TTL_MS,
  todayKey,
  TZ,
  normalizeDni,
  isSesionDni,
} from "./config.js";

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }
}

function wipeOldSessionCookie() {
  try {
    document.cookie = "qb_sup=; Path=/; Max-Age=0; SameSite=Lax";
    if (location.protocol === "https:") {
      document.cookie = "qb_sup=; Path=/; Max-Age=0; SameSite=Lax; Secure";
    }
  } catch {
    /* Safari / modo privado */
  }
}

wipeOldSessionCookie();

function slimSesion(s) {
  const dni = typeof s === "string" ? normalizeDni(s) : normalizeDni(s?.dni || s?.id);
  const row = { v: 1, dni, at: Date.now() };
  if (s && typeof s === "object" && s.emergencia) {
    row.emergencia = true;
    row.apellido = String(s.apellido || "").trim();
    row.nombre = String(s.nombre || "").trim();
  }
  return row;
}

const IDB_NAME = "cocina-qb";
const IDB_STORE = "sesion";

function openIdb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("no_idb"));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutDni(dni) {
  let db;
  try {
    db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(dni, "dni");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* el celular sigue con localStorage */
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

async function idbGetDni() {
  let db;
  try {
    db = await openIdb();
    const raw = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get("dni");
      req.onsuccess = () => resolve(req.result || "");
      req.onerror = () => reject(req.error);
    });
    const dni = normalizeDni(raw);
    return isSesionDni(dni) ? dni : "";
  } catch {
    return "";
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

async function idbDelDni() {
  let db;
  try {
    db = await openIdb();
    await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete("dni");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* ignore */
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export const store = {
  getCola() {
    return read(STORAGE_KEYS.cola, []);
  },
  upsertCola(record) {
    const cola = this.getCola().filter((r) => r.clientId !== record.clientId);
    cola.unshift(record);
    write(STORAGE_KEYS.cola, cola);
    return cola;
  },
  removeCola(clientId) {
    write(STORAGE_KEYS.cola, this.getCola().filter((r) => r.clientId !== clientId));
  },
  getHistorial() {
    this.pruneHistorial();
    return read(STORAGE_KEYS.historial, []);
  },
  pushHistorial(record) {
    const list = this.getHistorial().filter((r) => r.clientId !== record.clientId);
    list.unshift({ ...record, savedAt: Date.now() });
    write(STORAGE_KEYS.historial, list);
  },
  pruneHistorial() {
    const list = read(STORAGE_KEYS.historial, []).filter((r) => Date.now() - (r.savedAt || 0) < HISTORY_TTL_MS);
    write(STORAGE_KEYS.historial, list);
  },
  getDrafts() {
    return read(STORAGE_KEYS.borradores, {});
  },
  setDraft(formId, data) {
    const all = this.getDrafts();
    all[formId] = { data, updatedAt: Date.now() };
    write(STORAGE_KEYS.borradores, all);
  },
  clearDraft(formId) {
    const all = this.getDrafts();
    delete all[formId];
    write(STORAGE_KEYS.borradores, all);
  },
  clearDraftsOnly() {
    write(STORAGE_KEYS.borradores, {});
  },
  getPrefs() {
    return read(STORAGE_KEYS.prefs, { voice: true, scriptUrl: "" });
  },
  setPrefs(patch) {
    write(STORAGE_KEYS.prefs, { ...this.getPrefs(), ...patch });
  },
  getSesion() {
    const local = read(STORAGE_KEYS.sesion, null);
    const dni = normalizeDni(local?.dni || local?.id);
    return isSesionDni(dni) ? local : null;
  },
  getSesionDni() {
    const local = read(STORAGE_KEYS.sesion, null);
    const fromStore = normalizeDni(local?.dni || local?.id);
    return isSesionDni(fromStore) ? fromStore : "";
  },
  setSesion(s) {
    const dni = normalizeDni(s?.dni || s?.id);
    if (!isSesionDni(dni)) return false;
    const ok = write(STORAGE_KEYS.sesion, slimSesion(s));
    idbPutDni(dni);
    return ok;
  },
  async restoreSesion() {
    const local = read(STORAGE_KEYS.sesion, null);
    let dni = normalizeDni(local?.dni || local?.id);
    if (!isSesionDni(dni)) dni = await idbGetDni();
    if (!isSesionDni(dni)) return "";
    if (local?.emergencia && normalizeDni(local.dni || local.id) === dni) {
      this.setSesion({
        dni,
        emergencia: true,
        apellido: local.apellido || "",
        nombre: local.nombre || "",
      });
      return dni;
    }
    this.setSesion({ dni });
    return dni;
  },
  clearSesion() {
    try {
      localStorage.removeItem(STORAGE_KEYS.sesion);
      localStorage.removeItem(STORAGE_KEYS.turnoDia);
    } catch {
      /* ignore */
    }
    wipeOldSessionCookie();
    idbDelDni();
  },
  getTurnoDia() {
    const row = read(STORAGE_KEYS.turnoDia, null);
    const day = todayKey(TZ);
    const sid = normalizeDni(this.getSesionDni() || row?.dni);
    if (!row || row.fecha !== day) return null;
    if (sid && normalizeDni(row.dni) && normalizeDni(row.dni) !== sid) return null;
    return row;
  },
  setTurnoDia(patch = {}) {
    const day = todayKey(TZ);
    const sid = normalizeDni(patch.dni || this.getSesionDni());
    if (!isSesionDni(sid)) return false;
    return write(STORAGE_KEYS.turnoDia, {
      dni: sid,
      fecha: patch.fecha || day,
      comida: patch.comida || "Almuerzo",
      enviado: !!patch.enviado,
      at: Date.now(),
    });
  },
  clearTurnoDia() {
    try {
      localStorage.removeItem(STORAGE_KEYS.turnoDia);
    } catch {
      /* ignore */
    }
  },
  getLocalWorkers() {
    return read(STORAGE_KEYS.catalogoTrab, []);
  },
  upsertLocalWorker(w) {
    const list = this.getLocalWorkers().filter((x) => x.id !== w.id);
    list.unshift(w);
    write(STORAGE_KEYS.catalogoTrab, list);
    this.touchReciente(w);
    return list;
  },
  getLocalSupervisors() {
    return read(STORAGE_KEYS.catalogoSup, []);
  },
  upsertLocalSupervisor(s) {
    const list = this.getLocalSupervisors().filter((x) => x.id !== s.id);
    list.unshift(s);
    write(STORAGE_KEYS.catalogoSup, list);
    return list;
  },
  getRecientes() {
    return read(STORAGE_KEYS.recientes, []);
  },
  touchReciente(person) {
    const list = this.getRecientes().filter((x) => x.id !== person.id);
    list.unshift({ id: person.id, apellido: person.apellido, nombre: person.nombre, kind: person.kind || "wrk" });
    write(STORAGE_KEYS.recientes, list.slice(0, 30));
  },
  getDniGuardados() {
    return read(STORAGE_KEYS.dniGuardados, []);
  },
  upsertDniGuardado(person) {
    const id = normalizeDni(person.dni || person.id);
    if (!id) return this.getDniGuardados();
    const list = this.getDniGuardados().filter((x) => normalizeDni(x.id || x.dni) !== id);
    list.unshift({
      id,
      dni: id,
      apellido: person.apellido || "",
      nombre: person.nombre || "",
      cargo: person.cargo || person.area || "",
      temporal: !!person.temporal,
      savedAt: Date.now(),
    });
    write(STORAGE_KEYS.dniGuardados, list.slice(0, 200));
    return list;
  },
  clearDniGuardados() {
    write(STORAGE_KEYS.dniGuardados, []);
  },
  clearRecientes() {
    write(STORAGE_KEYS.recientes, []);
  },
  getMesa() {
    const raw = read(STORAGE_KEYS.mesa, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter((p) => p && p.id);
  },
  setMesa(list) {
    const day = todayKey(TZ);
    write(STORAGE_KEYS.mesa, (list || []).map((p) => ({ ...p, fecha: p.fecha || day })));
  },
  clearMesa() {
    write(STORAGE_KEYS.mesa, []);
  },
  getScriptUrl() {
    return (this.getPrefs().scriptUrl || localStorage.getItem(STORAGE_KEYS.scriptUrl) || "").trim();
  },
  setScriptUrl(url) {
    this.setPrefs({ scriptUrl: url.trim() });
    localStorage.setItem(STORAGE_KEYS.scriptUrl, url.trim());
  },
};

export function recordsOfToday(timeZone = TZ) {
  const day = todayKey(timeZone);
  const cola = store.getCola().filter((r) => r.payload?.fecha_local === day);
  const hist = store.getHistorial().filter((r) => r.payload?.fecha_local === day);
  const byId = new Map();
  for (const r of hist) byId.set(r.clientId, { ...r, status: "enviado" });
  for (const r of cola) {
    if (!byId.has(r.clientId)) byId.set(r.clientId, { ...r, status: "pendiente" });
  }
  return [...byId.values()];
}
