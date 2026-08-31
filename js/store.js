import {
  STORAGE_KEYS,
  HISTORY_TTL_MS,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
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

function cookieDni() {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]*)`));
    if (!m) return "";
    const dni = normalizeDni(decodeURIComponent(m[1]));
    return isSesionDni(dni) ? dni : "";
  } catch {
    return "";
  }
}

function writeCookie(dni) {
  try {
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(dni)}`,
      "Path=/",
      "SameSite=Lax",
      `Max-Age=${SESSION_MAX_AGE_SEC}`,
    ];
    if (location.protocol === "https:") parts.push("Secure");
    document.cookie = parts.join("; ");
  } catch {
    /* iOS / modo privado: localStorage sigue siendo el respaldo */
  }
}

function clearCookie() {
  try {
    document.cookie = `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  } catch {
    /* ignore */
  }
}

function slimSesion(dni) {
  return { v: 1, dni, at: Date.now() };
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
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(dni, "dni");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* el celular sigue con localStorage / cookie */
  }
}

async function idbGetDni() {
  try {
    const db = await openIdb();
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
  }
}

async function idbDelDni() {
  try {
    const db = await openIdb();
    await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete("dni");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* ignore */
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
    const dni = this.getSesionDni();
    return dni ? slimSesion(dni) : null;
  },
  getSesionDni() {
    const local = read(STORAGE_KEYS.sesion, null);
    const fromStore = normalizeDni(local?.dni || local?.id);
    if (isSesionDni(fromStore)) return fromStore;
    return cookieDni();
  },
  setSesion(s) {
    const dni = normalizeDni(s?.dni || s?.id);
    if (!isSesionDni(dni)) return false;
    const ok = write(STORAGE_KEYS.sesion, slimSesion(dni));
    writeCookie(dni);
    idbPutDni(dni);
    return ok || !!cookieDni();
  },
  async restoreSesion() {
    let dni = this.getSesionDni();
    if (!isSesionDni(dni)) dni = await idbGetDni();
    if (!isSesionDni(dni)) return "";
    this.setSesion({ dni });
    return dni;
  },
  clearSesion() {
    try {
      localStorage.removeItem(STORAGE_KEYS.sesion);
    } catch {
      /* ignore */
    }
    clearCookie();
    idbDelDni();
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
