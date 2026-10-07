/**
 * Reproduce offline → 3G → POST → confirmación de API.
 * No toca el Apps Script real.
 */
const listeners = new Map();
globalThis.addEventListener = (type, fn) => {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
};
globalThis.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn);
function emit(type) {
  for (const fn of listeners.get(type) || []) fn();
}

const connListeners = new Set();
const connection = {
  effectiveType: "4g",
  downlink: 10,
  rtt: 50,
  saveData: false,
  addEventListener(type, fn) {
    if (type === "change") connListeners.add(fn);
  },
  removeEventListener(type, fn) {
    connListeners.delete(fn);
  },
  emit() {
    for (const fn of connListeners) fn();
  },
};

function memoryStorage() {
  const map = new Map();
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(key); },
    clear() { map.clear(); },
    key(i) { return [...map.keys()][i] ?? null; },
    get length() { return map.size; },
  };
}

function memoryIdb() {
  const dbs = new Map();
  return {
    open(name, version) {
      const req = {};
      let db = dbs.get(name);
      const fresh = !db;
      if (!db) {
        db = { stores: new Map(), version };
        db.objectStoreNames = { contains: (n) => db.stores.has(n) };
        db.createObjectStore = (storeName) => {
          const store = { map: new Map() };
          db.stores.set(storeName, store);
          return store;
        };
        db.transaction = (storeName) => {
          const store = db.stores.get(storeName);
          const tx = {
            objectStore() {
              return {
                put(value, key) {
                  store.map.set(key, JSON.parse(JSON.stringify(value)));
                },
                delete(key) { store.map.delete(key); },
                get(key) {
                  const out = {};
                  queueMicrotask(() => {
                    const hit = store.map.get(key);
                    out.result = hit === undefined ? undefined : JSON.parse(JSON.stringify(hit));
                    out.onsuccess?.();
                  });
                  return out;
                },
              };
            },
          };
          queueMicrotask(() => tx.oncomplete?.());
          return tx;
        };
        db.close = () => {};
        dbs.set(name, db);
      }
      db.version = version;
      queueMicrotask(() => {
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

const documentStub = {
  _cookie: "",
  get cookie() { return this._cookie; },
  set cookie(value) { this._cookie = String(value); },
};
const navigatorStub = {
  onLine: true,
  connection,
  userAgent: "Mozilla/5.0 (Linux; Android 13; Mobile) Test",
};
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
defineGlobal("document", documentStub);
defineGlobal("location", { protocol: "http:", href: "http://127.0.0.1/" });
defineGlobal("localStorage", memoryStorage());
defineGlobal("indexedDB", memoryIdb());
defineGlobal("navigator", navigatorStub);
defineGlobal("window", globalThis);

const { todayKey } = await import("../js/config.js");
const { store } = await import("../js/store.js");
const sync = await import("../js/sync.js");

const day = todayKey();
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(obj); },
  };
}

const sink = { calls: [], mode: "ok", hangGet: false, hangPost: false, failPosts: 0, hold: false, maxOk: 0, okSeen: 0 };

function installFetch() {
  globalThis.fetch = (url, opts = {}) => new Promise((resolve, reject) => {
    const method = String(opts.method || "GET").toUpperCase();
    if (opts.signal) {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (opts.signal.aborted) {
        abort();
        return;
      }
      opts.signal.addEventListener("abort", abort, { once: true });
    }
    if (method === "GET") {
      sink.calls.push({ method, at: Date.now(), url: String(url) });
      if (sink.hangGet) return;
      if (sink.mode === "down") {
        reject(new TypeError("Failed to fetch"));
        return;
      }
      resolve(jsonResponse({ ok: true, ping: true, fundos: ["Norte"] }));
      return;
    }
    const body = JSON.parse(opts.body || "{}");
    const call = { method, at: Date.now(), body };
    sink.calls.push(call);
    if (sink.hangPost) return;
    const finish = (payload, status = 200) => resolve(jsonResponse(payload, status));
    if (sink.hold) {
      call.release = () => finish({ ok: true, saved: true, trabajadores: 1, total: 1 });
      return;
    }
    if (sink.maxOk > 0) {
      sink.okSeen += 1;
      if (sink.okSeen > sink.maxOk) {
        reject(new TypeError("Failed to fetch"));
        return;
      }
    }
    if (sink.failPosts > 0) {
      sink.failPosts -= 1;
      reject(new TypeError("Failed to fetch"));
      return;
    }
    if (sink.mode === "http500") {
      finish({ ok: false, error: "server" }, 500);
      return;
    }
    if (sink.mode === "timeout") {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    if (sink.mode === "empty") {
      finish({ ok: true });
      return;
    }
    if (sink.mode === "duplicate") {
      finish({ ok: true, saved: true, duplicate: true, trabajadores: 1, total: 1 });
      return;
    }
    finish({
      ok: true,
      saved: true,
      trabajadores: body.payload?.personas?.length || 1,
      total: 1,
    });
  });
}

function postsFor(id) {
  return sink.calls.filter((c) => c.method === "POST" && c.body?.clientId === id);
}

function makeRecord(id, type = "lista", payload = {}) {
  return {
    clientId: id,
    type,
    payload: {
      fecha_local: day,
      hora_local: "12:00:00.000",
      timezone: "America/Lima",
      supervisor_id: "12345678",
      comida: "Almuerzo",
      extra: type === "extra",
      personas: [{ id: "87654321", dni: "87654321", apellido: "QUISPE", nombre: "Ana" }],
      ...payload,
    },
    createdAt: Date.now(),
  };
}

function setLink({ online = true, effectiveType = "4g", downlink = 10, rtt = 50, saveData = false } = {}) {
  navigator.onLine = online;
  connection.effectiveType = effectiveType;
  connection.downlink = downlink;
  connection.rtt = rtt;
  connection.saveData = saveData;
}

async function emptyQueue() {
  sink.hold = false;
  sink.hangGet = false;
  sink.hangPost = false;
  sink.failPosts = 0;
  sink.maxOk = 0;
  sink.okSeen = 0;
  sink.mode = "ok";
  for (const row of sink.calls) row.release?.();
  for (const row of [...store.getCola()]) store.removeCola(row.clientId);
  store.clearTurnoDia();
  await sync.flushQueue();
  sink.calls = [];
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("cocina-qb", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("sesion")) db.createObjectStore("sesion");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve();
  });
}

async function testHydrateNewerIdb() {
  const db = await openDb();
  await idbPut(db, "cola_pendiente", {
    at: 9000,
    list: [makeRecord("nuevo")],
  });
  db.close();
  localStorage.setItem("cola_pendiente", JSON.stringify([makeRecord("viejo")]));
  localStorage.setItem("cola_pendiente@at", "10");
  await store.restoreSesion();
  const ids = store.getCola().map((r) => r.clientId);
  check("IndexedDB más nuevo recupera la cola si localStorage quedó viejo", ids.includes("nuevo") && !ids.includes("viejo"), ids.join(","));
  store.removeCola("nuevo");
}

async function testOfflineThen3g() {
  setLink({ online: false });
  emit("offline");
  sink.calls = [];
  const id = "lista-campo";
  const saved = await sync.saveAndSync(makeRecord(id, "lista", { hora_local: "11:11:11.111" }));
  const raw = JSON.parse(localStorage.getItem("cola_pendiente") || "[]");
  check("Sin señal no llama a la API", saved.status === "pendiente" && !postsFor(id).length);
  check("Sin señal el pedido queda en localStorage", raw.some((r) => r.clientId === id && r.payload.hora_local === "11:11:11.111"));

  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 400 });
  sink.calls = [];
  const t0 = Date.now();
  emit("online");
  connection.emit();
  const arrived = await waitPosts(id, 1, 1500);
  const waited = Date.now() - t0;
  const mine = postsFor(id);
  check("Al pasar a 3G el POST sale solo", arrived && mine.length === 1, `${mine.length} posts`);
  check("En 3G no espera el ping de 4s", waited < 1500 && !sink.calls.some((c) => c.method === "GET"), `${waited}ms`);
  check("El POST conserva la hora local", mine[0]?.body?.payload?.hora_local === "11:11:11.111");
  check("La API confirma y la cola se vacía", store.getCola().every((r) => r.clientId !== id));
  const hist = store.getHistorial().filter((r) => r.clientId === id);
  check("Queda una sola confirmación en el historial", hist.length === 1 && hist[0].confirmed === true && hist[0].duplicate !== true, `n=${hist.length}`);
  await emptyQueue();
}

async function waitPosts(id, n, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (postsFor(id).length >= n && store.getCola().every((r) => r.clientId !== id)) return true;
    await delay(20);
  }
  return postsFor(id).length >= n;
}

async function testSlowDownlinkSkipsPing() {
  setLink({ online: true, effectiveType: "4g", downlink: 0.35, rtt: 80 });
  sink.calls = [];
  const id = "lenta";
  store.upsertCola(makeRecord(id));
  const t0 = Date.now();
  await sync.flushQueue();
  const waited = Date.now() - t0;
  check("Enlace lento (downlink) hace POST sin ping", postsFor(id).length === 1 && !sink.calls.some((c) => c.method === "GET"), `${waited}ms`);
  check("Enlace lento responde en menos de 1s cuando la API contesta", waited < 1000, `${waited}ms`);
  await emptyQueue();
}

async function testNoDuplicateWhileInFlight() {
  setLink({ online: true, effectiveType: "4g", downlink: 10, rtt: 50 });
  sink.hold = true;
  sink.calls = [];
  const id = "unico";
  let movedOn = false;
  const first = sync.saveAndSync(makeRecord(id));
  await delay(30);
  movedOn = true;
  const second = sync.flushQueue();
  await delay(50);
  const queued = store.getCola().filter((r) => r.clientId === id);
  check("La app sigue mientras el POST está en curso", movedOn && queued.length === 1);
  check("Un mismo envío no se POSTEA dos veces", postsFor(id).length === 1, `posts=${postsFor(id).length}`);
  sink.calls.find((c) => c.body?.clientId === id)?.release?.();
  sink.hold = false;
  const [a, b] = await Promise.all([first, second]);
  check("Los dos caminos reciben la misma confirmación", a.status === "enviado" && (b.sent + b.duplicates) >= 1);
  check("No queda duplicado en historial", store.getHistorial().filter((r) => r.clientId === id).length === 1);
  await emptyQueue();
}

async function testOtherWorkNotBlocked() {
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 400 });
  sink.hold = true;
  sink.calls = [];
  const slow = sync.saveAndSync(makeRecord("lento"));
  await delay(20);
  const t0 = Date.now();
  store.getCola();
  const other = sync.saveAndSync(makeRecord("otro"));
  await delay(40);
  const waited = Date.now() - t0;
  check("Otro envío no espera a que termine el POST lento", postsFor("otro").length === 1 && waited < 500, `${waited}ms`);
  for (const row of sink.calls) row.release?.();
  sink.hold = false;
  await slow;
  await other;
  await emptyQueue();
}

async function testNeedsRealConfirmation() {
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 300 });
  sink.mode = "empty";
  sink.calls = [];
  const id = "sin-ok";
  const first = await sync.saveAndSync(makeRecord(id));
  check("Sin campos de confirmación el dato sigue guardado", first.status === "pendiente" && store.getCola().some((r) => r.clientId === id));
  sink.mode = "ok";
  const sum = await sync.flushQueue();
  check("El reintento posterior confirma y limpia la cola", sum.sent === 1 && store.getCola().every((r) => r.clientId !== id));
  await emptyQueue();
}

async function testDuplicateApiResponse() {
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 300 });
  sink.mode = "duplicate";
  sink.calls = [];
  const id = "dup-api";
  const result = await sync.saveAndSync(makeRecord(id));
  const hist = store.getHistorial().filter((r) => r.clientId === id);
  check("duplicate=true se acepta como confirmación y no se reenvía", result.duplicate === true && result.status === "enviado" && hist.length === 1 && postsFor(id).length === 1);
  await emptyQueue();
}

async function testBurstOrder() {
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 400 });
  sink.calls = [];
  store.upsertCola(makeRecord("cierre-1", "cierre", { personas: [] }));
  store.upsertCola(makeRecord("extra-1", "extra"));
  store.upsertCola(makeRecord("lista-1", "lista"));
  const t0 = Date.now();
  const sum = await sync.flushQueue();
  const waited = Date.now() - t0;
  const order = sink.calls.filter((c) => c.method === "POST").map((c) => c.body.type);
  check("Lista, extra y cierre salen una sola vez", sum.sent === 3 && order.length === 3, order.join(">"));
  check("El orden es lista → extra → cierre", order.join(">") === "lista>extra>cierre", order.join(">"));
  check("El lote en 3G termina en menos de 2s", waited < 2000, `${waited}ms`);
  check("La cola del lote queda vacía", store.getCola().length === 0);
  await emptyQueue();
}

async function testProbeTimeoutStillPosts() {
  setLink({ online: true, effectiveType: "4g", downlink: 8, rtt: 40 });
  sink.hangGet = true;
  sink.calls = [];
  const id = "ping-lento";
  store.upsertCola(makeRecord(id));
  const t0 = Date.now();
  const sum = await sync.flushQueue();
  const waited = Date.now() - t0;
  check("Si el ping se cuelga, igual se hace el POST", sum.sent === 1 && postsFor(id).length === 1, `${waited}ms`);
  check("Ese POST espera el fallo del ping y no se dispara en bucle", waited >= 3500 && waited < 7000, `${waited}ms`);
  await emptyQueue();
}

async function testDeadNetworkDoesNotPost() {
  setLink({ online: true, effectiveType: "4g", downlink: 10, rtt: 40 });
  sink.mode = "down";
  sink.hangGet = false;
  sink.calls = [];
  const id = "muerta";
  store.upsertCola(makeRecord(id));
  const sum = await sync.flushQueue();
  check("Si la red cae al instante no se pierde el dato ni se POSTEA", sum.pending === 1 && !postsFor(id).length && store.getCola().some((r) => r.clientId === id));
  await emptyQueue();
}

async function testQuotaKeepsMemoryAndIdb() {
  setLink({ online: false });
  const orig = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === "cola_pendiente") throw new Error("quota");
    return orig(key, value);
  };
  const id = "quota-1";
  try {
    store.upsertCola(makeRecord(id));
    check("Si localStorage rechaza la cola, la sesión la conserva", store.getCola().some((r) => r.clientId === id));
    await delay(30);
    const db = await openDb();
    const row = await new Promise((resolve) => {
      const tx = db.transaction("kv", "readonly");
      const req = tx.objectStore("kv").get("cola_pendiente");
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    const ids = (row?.list || []).map((r) => r.clientId);
    check("La copia de IndexedDB tiene el pedido que localStorage no pudo guardar", ids.includes(id), ids.join(","));
  } finally {
    localStorage.setItem = orig;
  }
  await emptyQueue();
}

async function testRetryUntilSuccess() {
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 450 });
  sink.failPosts = 2;
  sink.calls = [];
  const id = "reintento";
  const t0 = Date.now();
  const first = await sync.saveAndSync(makeRecord(id, "lista", { hora_local: "09:30:00.000" }));
  check("El primer fallo deja el pedido pendiente", first.status === "pendiente" && store.getCola().some((r) => r.clientId === id));
  const done = await waitPosts(id, 3, 20000);
  const mine = postsFor(id);
  const gaps = mine.slice(1).map((c, i) => c.at - mine[i].at);
  check("Reintenta hasta la confirmación de la API", done && store.getCola().every((r) => r.clientId !== id) && mine.length === 3, `posts=${mine.length}`);
  check("Los reintentos esperan y no se disparan en ráfaga", gaps.length === 2 && gaps[0] >= 3500 && gaps[1] >= 5000, gaps.join(","));
  check("La hora del campo no cambia entre reintentos", mine.every((c) => c.body.payload.hora_local === "09:30:00.000"));
  check("El ciclo completo cabe en 20s", Date.now() - t0 < 20000, `${Date.now() - t0}ms`);
  const hist = store.getHistorial().filter((r) => r.clientId === id);
  check("Un éxito después de fallos deja una sola fila local", hist.length === 1 && hist[0].confirmed === true);
  await emptyQueue();
}

async function testCloseReopenThen3g() {
  setLink({ online: false });
  emit("offline");
  sink.calls = [];
  const id = "tras-cierre";
  const saved = await sync.saveAndSync(makeRecord(id, "lista", {
    hora_local: "08:08:08.008",
    personas: [
      { id: "87654321", dni: "87654321", apellido: "QUISPE", nombre: "Ana" },
      { id: "11223344", dni: "11223344", apellido: "RAMOS", nombre: "Luis" },
    ],
  }));
  store.setMesa([{ id: "87654321", apellido: "QUISPE", nombre: "Ana" }]);
  check("El registro offline queda pendiente antes de cerrar", saved.status === "pendiente" && store.getCola().some((r) => r.clientId === id));
  store.checkpoint();
  store.releaseMemory();
  setLink({ online: true, effectiveType: "3g", downlink: 0.35, rtt: 480 });
  await store.restoreSesion();
  const back = store.getCola().find((r) => r.clientId === id);
  check("Al abrir la app el pendiente sigue en la cola", !!back && back.payload.hora_local === "08:08:08.008" && back.payload.personas.length === 2);
  check("La mesa local también vuelve", store.getMesa().some((p) => p.id === "87654321"));
  sink.calls = [];
  const t0 = Date.now();
  const sum = await sync.flushQueue();
  const mine = postsFor(id);
  check("Con 3G el pendiente se envía una sola vez", sum.sent === 1 && mine.length === 1, `posts=${mine.length}`);
  check("Ese POST no espera un ping", Date.now() - t0 < 1500 && !sink.calls.some((c) => c.method === "GET"));
  check("La hora y las personas del campo llegan igual", mine[0]?.body?.payload?.hora_local === "08:08:08.008" && mine[0]?.body?.payload?.personas?.length === 2);
  check("La API confirma y ya no queda pendiente", store.getCola().every((r) => r.clientId !== id) && store.getHistorial().filter((r) => r.clientId === id).length === 1);
  store.clearMesa();
  await emptyQueue();
}

async function testMemoryWipeKeepsIdb() {
  setLink({ online: false });
  const id = "solo-idb";
  await sync.saveAndSync(makeRecord(id, "extra"));
  await delay(40);
  localStorage.removeItem("cola_pendiente");
  localStorage.removeItem("cola_pendiente@at");
  store.releaseMemory();
  await store.restoreSesion();
  check("Si localStorage se borra al cerrar, IndexedDB devuelve el pendiente", store.getCola().some((r) => r.clientId === id));
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 400 });
  sink.calls = [];
  await sync.flushQueue();
  check("Ese pendiente recuperado se confirma una vez", postsFor(id).length === 1 && store.getCola().every((r) => r.clientId !== id));
  await emptyQueue();
}

async function testCheckpointRepairsLocal() {
  setLink({ online: false });
  const id = "checkpoint";
  store.upsertCola(makeRecord(id, "lista"));
  localStorage.removeItem("cola_pendiente");
  localStorage.removeItem("cola_pendiente@at");
  store.checkpoint();
  store.releaseMemory();
  const raw = JSON.parse(localStorage.getItem("cola_pendiente") || "[]");
  check("Al cerrar, la copia en memoria vuelve a localStorage", raw.some((r) => r.clientId === id));
  await store.restoreSesion();
  await emptyQueue();
}

async function testTurnoFlagDoesNotDropPending() {
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 420 });
  store.setSesion({ dni: "12345678" });
  store.setTurnoDia({ dni: "12345678", fecha: day, comida: "Almuerzo", enviado: true });
  sink.calls = [];
  const id = "no-se-borra";
  store.upsertCola(makeRecord(id, "lista"));
  const sum = await sync.flushQueue();
  check("Un pendiente no se descarta solo porque el turno figure enviado", sum.sent === 1 && postsFor(id).length === 1 && store.getCola().every((r) => r.clientId !== id));
  await emptyQueue();
}

async function testSeveralPendingOnSlowLink() {
  setLink({ online: true, effectiveType: "3g", downlink: 0.2, rtt: 700, saveData: true });
  sink.failPosts = 1;
  sink.calls = [];
  store.upsertCola(makeRecord("lote-a", "lista"));
  store.upsertCola(makeRecord("lote-b", "extra"));
  store.upsertCola(makeRecord("lote-c", "cierre", { personas: [] }));
  const first = await sync.flushQueue();
  const ids = ["lote-a", "lote-b", "lote-c"];
  check("Si el primer POST falla, los demás siguen guardados", first.errors >= 1 && ids.every((id) => store.getCola().some((r) => r.clientId === id)), `cola=${store.getCola().map((r) => r.clientId).join(",")}`);
  sink.failPosts = 0;
  sink.calls = [];
  const t0 = Date.now();
  const done = await sync.flushQueue();
  const posted = ids.map((id) => postsFor(id).length);
  check("Al recuperarse, cada pendiente sale una sola vez", done.sent + done.duplicates === 3 && posted.every((n) => n === 1), posted.join(","));
  check("Varios pendientes en 3G no se quedan colgados", Date.now() - t0 < 2000, `${Date.now() - t0}ms`);
  check("La cola del lote queda vacía", store.getCola().length === 0);
  await emptyQueue();
}

async function testHttpErrorAndAbortStayQueued() {
  setLink({ online: true, effectiveType: "4g", downlink: 8, rtt: 40 });
  sink.mode = "http500";
  sink.calls = [];
  const id = "http-500";
  const failed = await sync.saveAndSync(makeRecord(id));
  check("Un HTTP 500 deja el registro pendiente", failed.status === "pendiente" && store.getCola().some((r) => r.clientId === id) && postsFor(id).length === 1);
  sink.mode = "timeout";
  const aborted = await sync.flushQueue();
  check("Un corte o timeout no borra el pendiente", aborted.pending === 1 && store.getCola().some((r) => r.clientId === id));
  sink.mode = "ok";
  await sync.flushQueue();
  check("Después del corte se confirma una sola vez más", postsFor(id).length === 3 && store.getHistorial().filter((r) => r.clientId === id).length === 1);
  await emptyQueue();
}

async function testHplusWindowSkipsProbe() {
  setLink({ online: false });
  emit("offline");
  sink.calls = [];
  const id = "hplus-ventana";
  const saved = await sync.saveAndSync(makeRecord(id, "lista", { hora_local: "10:10:10.010" }));
  check("Sin señal el pendiente de H+ no sale", saved.status === "pendiente" && !postsFor(id).length);
  setLink({ online: true, effectiveType: "4g", downlink: 2.5, rtt: 160 });
  sink.calls = [];
  const t0 = Date.now();
  emit("online");
  connection.emit();
  const arrived = await waitPosts(id, 1, 1500);
  const waited = Date.now() - t0;
  check("Al aparecer H+ el POST sale sin ping previo", arrived && postsFor(id).length === 1 && !sink.calls.some((c) => c.method === "GET"), `${waited}ms`);
  check("Esa ventana corta confirma una sola vez", store.getHistorial().filter((r) => r.clientId === id).length === 1 && store.getCola().every((r) => r.clientId !== id));
  await emptyQueue();
}

async function testWeak4gSkipsProbe() {
  setLink({ online: true, effectiveType: "4g", downlink: 3, rtt: 220 });
  sink.calls = [];
  const id = "hplus-debil";
  store.upsertCola(makeRecord(id));
  const t0 = Date.now();
  await sync.flushQueue();
  const waited = Date.now() - t0;
  check("H+ con RTT alto envía sin ping", postsFor(id).length === 1 && !sink.calls.some((c) => c.method === "GET"), `${waited}ms`);
  await emptyQueue();
}

async function testManyOn3g(count, label) {
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 400 });
  sink.calls = [];
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const id = `${label}-${i}`;
    ids.push(id);
    store.upsertCola(makeRecord(id, i < Math.ceil(count / 5) ? "lista" : "extra"));
  }
  const t0 = Date.now();
  const sum = await sync.flushQueue();
  const posted = ids.map((id) => postsFor(id).length);
  const waited = Date.now() - t0;
  check(`${count} pendientes en 3G salen una sola vez`, sum.sent === count && posted.every((n) => n === 1) && store.getCola().length === 0, `${waited}ms ${posted.filter((n) => n !== 1).length} raros`);
  const types = sink.calls.filter((c) => c.method === "POST").map((c) => c.body.type);
  const firstExtra = types.indexOf("extra");
  const lastLista = types.lastIndexOf("lista");
  check(`${count} pendientes respetan lista antes que extra`, firstExtra === -1 || lastLista < firstExtra, types.slice(0, 3).join(">"));
  await emptyQueue();
}

async function testSignalDropAbortsAndResumes() {
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 400 });
  sink.hangPost = true;
  sink.calls = [];
  const id = "corte-3g";
  store.upsertCola(makeRecord(id, "lista", { hora_local: "07:07:07.007" }));
  const job = sync.flushQueue();
  await delay(40);
  check("El corte ocurre con un solo POST en curso", postsFor(id).length === 1);
  const t0 = Date.now();
  setLink({ online: false });
  emit("offline");
  const sum = await job;
  const waited = Date.now() - t0;
  check("Si 3G desaparece, se aborta y el dato sigue pendiente", waited < 1500 && sum.pending === 1 && store.getCola().some((r) => r.clientId === id), `${waited}ms`);
  sink.hangPost = false;
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 400 });
  emit("online");
  connection.emit();
  const back = await waitPosts(id, 2, 2000);
  check("Al volver 3G se confirma sin duplicar", back && postsFor(id).length === 2 && store.getHistorial().filter((r) => r.clientId === id).length === 1 && store.getCola().every((r) => r.clientId !== id));
  await emptyQueue();
}

async function testLostResponseUsesSameId() {
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 350 });
  sink.failPosts = 1;
  sink.calls = [];
  const id = "respuesta-perdida";
  const first = await sync.saveAndSync(makeRecord(id, "lista", { hora_local: "06:06:06.006" }));
  check("Si la respuesta no llega, el pendiente se conserva", first.status === "pendiente" && store.getCola().some((r) => r.clientId === id) && postsFor(id).length === 1);
  sink.mode = "duplicate";
  const sum = await sync.flushQueue();
  const hist = store.getHistorial().filter((r) => r.clientId === id);
  check("El reintento usa el mismo id y una confirmación basta", sum.duplicates === 1 && postsFor(id).length === 2 && hist.length === 1 && postsFor(id).every((c) => c.body.clientId === id));
  await emptyQueue();
}

async function testShortWindowKeepsTheRest() {
  setLink({ online: true, effectiveType: "3g", downlink: 0.3, rtt: 500 });
  sink.calls = [];
  sink.maxOk = 2;
  const ids = ["win-0", "win-1", "win-2", "win-3", "win-4"];
  ids.forEach((id, i) => {
    const row = makeRecord(id);
    row.createdAt = 1000 + i;
    store.upsertCola(row);
  });
  const sum = await sync.flushQueue();
  const sentIds = sink.calls.filter((c) => c.method === "POST").map((c) => c.body.clientId);
  const left = store.getCola().map((r) => r.clientId);
  check("En una ventana corta salen primero los más antiguos", sum.sent === 2 && sentIds[0] === "win-0" && sentIds[1] === "win-1" && left.length === 3, sentIds.join(","));
  check("Lo no enviado sigue en la cola", left.length === 3 && sentIds.slice(0, 2).every((id) => !left.includes(id)));
  sink.maxOk = 0;
  sink.okSeen = 0;
  sink.calls = [];
  const done = await sync.flushQueue();
  const posted = left.map((id) => postsFor(id).length);
  check("Al volver la señal salen los que faltaban, una vez", done.sent === 3 && store.getCola().length === 0 && posted.every((n) => n === 1), posted.join(","));
  await emptyQueue();
}

async function testRegisterWhileSyncing() {
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 400 });
  sink.hold = true;
  sink.calls = [];
  store.upsertCola(makeRecord("sync-0"));
  store.upsertCola(makeRecord("sync-1"));
  const job = sync.flushQueue();
  await delay(30);
  const t0 = Date.now();
  const extra = sync.saveAndSync(makeRecord("sync-nuevo", "extra", { hora_local: "05:05:05.005" }));
  await delay(40);
  const waited = Date.now() - t0;
  check("Registrar durante la sync no bloquea y queda guardado", waited < 500 && postsFor("sync-nuevo").length === 1 && store.getCola().some((r) => r.clientId === "sync-nuevo"), `${waited}ms`);
  for (const row of sink.calls) row.release?.();
  sink.hold = false;
  await job;
  await extra;
  const ids = ["sync-0", "sync-1", "sync-nuevo"];
  check("Los tres quedan confirmados una sola vez", ids.every((id) => store.getHistorial().filter((r) => r.clientId === id).length === 1 && store.getCola().every((r) => r.clientId !== id)));
  await emptyQueue();
}

async function testSignalFlips() {
  setLink({ online: false });
  emit("offline");
  const id = "flip-1";
  await sync.saveAndSync(makeRecord(id));
  setLink({ online: true, effectiveType: "4g", downlink: 2.2, rtt: 170 });
  sink.calls = [];
  emit("online");
  connection.emit();
  const h = await waitPosts(id, 1, 1500);
  check("H+ envía el pendiente", h && postsFor(id).length === 1);
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 450 });
  connection.emit();
  const id2 = "flip-2";
  store.upsertCola(makeRecord(id2));
  await sync.flushQueue();
  check("Al bajar a 3G el nuevo pendiente sale una vez", postsFor(id2).length === 1);
  setLink({ online: false });
  emit("offline");
  const id3 = "flip-3";
  const held = await sync.saveAndSync(makeRecord(id3));
  check("Sin internet el tercero no se pierde ni se envía", held.status === "pendiente" && !postsFor(id3).length && store.getCola().some((r) => r.clientId === id3));
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 400 });
  emit("online");
  connection.emit();
  const back = await waitPosts(id3, 1, 1500);
  check("Al regresar 3G el tercero se confirma una vez", back && postsFor(id3).length === 1 && store.getHistorial().filter((r) => r.clientId === id3).length === 1);
  await emptyQueue();
}

async function testPostTimeoutKeepsPending() {
  setLink({ online: true, effectiveType: "3g", downlink: 0.4, rtt: 400 });
  sink.hangPost = true;
  sink.calls = [];
  const id = "post-lento";
  store.upsertCola(makeRecord(id, "extra"));
  const t0 = Date.now();
  const sum = await sync.flushQueue();
  const waited = Date.now() - t0;
  check("Si el POST no responde, el dato sigue pendiente", sum.pending === 1 && store.getCola().some((r) => r.clientId === id), `${waited}ms`);
  check("Ese intento corta por timeout y no se duplica", postsFor(id).length === 1 && waited >= 44000 && waited < 52000, `${waited}ms posts=${postsFor(id).length}`);
  sink.hangPost = false;
  await sync.flushQueue();
  check("Cuando la API vuelve a responder, se confirma sin duplicar", postsFor(id).length === 2 && store.getCola().every((r) => r.clientId !== id) && store.getHistorial().filter((r) => r.clientId === id).length === 1);
  await emptyQueue();
}

installFetch();
await testHydrateNewerIdb();
store.setScriptUrl("https://sync.test/exec");
await sync.startAutoSync();
await emptyQueue();

await testOfflineThen3g();
await testSlowDownlinkSkipsPing();
await testNoDuplicateWhileInFlight();
await testOtherWorkNotBlocked();
await testNeedsRealConfirmation();
await testDuplicateApiResponse();
await testBurstOrder();
await testDeadNetworkDoesNotPost();
await testQuotaKeepsMemoryAndIdb();
await testProbeTimeoutStillPosts();
await testRetryUntilSuccess();
await testCloseReopenThen3g();
await testMemoryWipeKeepsIdb();
await testCheckpointRepairsLocal();
await testTurnoFlagDoesNotDropPending();
await testSeveralPendingOnSlowLink();
await testHttpErrorAndAbortStayQueued();
await testHplusWindowSkipsProbe();
await testWeak4gSkipsProbe();
await testManyOn3g(10, "lote10");
await testManyOn3g(50, "lote50");
await testManyOn3g(100, "lote100");
await testSignalDropAbortsAndResumes();
await testLostResponseUsesSameId();
await testShortWindowKeepsTheRest();
await testRegisterWhileSyncing();
await testSignalFlips();
await testPostTimeoutKeepsPending();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones ok`);
if (failed.length) {
  console.log(failed.map((r) => r.name).join("\n"));
  process.exit(1);
}
