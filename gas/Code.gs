/**
 * Cocina QBerries — Google Apps Script
 * Pegar en Extensiones → Apps Script. Implementar como Web App:
 *   Ejecutar como: yo   ·   Quién tiene acceso: Cualquiera
 *
 * La app de campo (Netlify) NO se toca. Sigue POSTeando { clientId, type, payload }.
 *
 * Admin (panel RH/cocina) — pegar ESTA misma URL /exec en js/config.js → apiUrl
 *   GET  /exec                      → hoy + ayer Lima  { ok, ping, reservas }
 *   GET  /exec?fecha=YYYY-MM-DD
 *   GET  /exec?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 *   GET  /exec?path=reservas        (igual)
 *   GET  /exec?path=supervisores
 *   GET  /exec?path=comedores
 *   GET  /exec?path=turno&supervisor=DNI   → { enviado, extra_ok }  (hoy Lima)
 *   POST /exec  { dni, name, supervisor }                    → RH agrega (hoy)
 *   POST /exec  { action: "quitar", dni, date }              → RH cancela
 *   GET  /exec?action=add&dni=&name=&supervisor=             → igual (si CORS bloquea POST)
 *   GET  /exec?action=quitar&dni=&date=
 *
 * Hojas: Trabajadores, Supervisores, Comidas extras.
 * hora_guardado = hora del celular. No se guarda client_id.
 * Lock del turno (solo hojas, no catálogo de internet):
 *   1) ¿Este supervisor_id ya está hoy en la hoja Supervisores?
 *   2) ¿Este supervisor_id ya tiene gente hoy en la hoja Trabajadores?
 *   Si SÍ → no se escribe otra vez en Trabajadores ni en Supervisores.
 *   Solo se puede registrar en Comidas extras.
 *   Si 2 o 3 celulares mandan el mismo supervisor, el primero gana.
 *
 * Supervisores: NO son fijos. Se leen de data/supervisors.json (byDni).
 * URL por defecto = app en Netlify. Se puede cambiar en Propiedades del script → SUPERVISORS_URL.
 *
 * Tras pegar: ejecutar setupSheets una vez. Opcional: seedDemoData (prueba hoy/ayer).
 */

var CACHE_TTL_SEC = 21600;
var ADMIN_CACHE_SEC = 4;
var APP_VERSION = "1.2.3";
var TZ = "America/Lima";

var COLS_TRABAJADORES = [
  "fecha_local",
  "hora_guardado",
  "supervisor_id",
  "supervisor_apellido",
  "trabajador_dni",
  "trabajador_apellido",
  "trabajador_nombre",
  "comida",
  "comedor",
  "etapa",
  "id",
  "status"
];

var COLS_SUPERVISORES = [
  "fecha_local",
  "hora_guardado",
  "supervisor_id",
  "supervisor_apellido",
  "comida",
  "comedor",
  "etapa",
  "total_comidas"
];

var SUPERVISORS_JSON_URL = "https://almuerzo-qberries.netlify.app/data/supervisors.json";
var SUP_CACHE_SEC = 60;

var COMEDORES = [
  "Comedor 1", "Comedor 2", "Comedor 3", "Comedor 4", "Comedor 5",
  "Comedor 6", "Comedor 7", "Comedor 8", "Comedor 9", "Comedor 10",
  "Comedor 11", "Comedor Galpón", "Garita 1", "Garita 2", "Comedor Administrativo"
];

function doGet(e) {
  var q = (e && e.parameter) ? e.parameter : {};
  var path = String(q.path || q.ruta || "").toLowerCase();
  var action = String(q.action || q.accion || "").toLowerCase();

  if (action === "add" || action === "agregar") {
    return adminAdd({
      dni: q.dni,
      name: q.name || q.nombre,
      supervisor: q.supervisor,
      sede: q.sede || q.comedor
    });
  }
  if (action === "quitar" || action === "cancel" || action === "cancelar") {
    return adminQuitar({ dni: q.dni, date: q.date || q.fecha, id: q.id });
  }
  if (path === "supervisores") {
    return jsonOut({ ok: true, supervisores: loadSupervisors() });
  }
  if (path === "comedores") {
    return jsonOut({ ok: true, comedores: COMEDORES.map(function (n) { return { name: n, sede: n }; }) });
  }
  if (path === "turno" || action === "turno") {
    return turnoStatus(q);
  }

  var range = dateRangeFromQuery(q);
  return jsonOut({
    ok: true,
    ping: true,
    version: APP_VERSION,
    app: "Cocina QBerries",
    time: new Date().toISOString(),
    timezone: TZ,
    desde: range.desde,
    hasta: range.hasta,
    reservas: listReservas(range.desde, range.hasta)
  });
}

function doPost(e) {
  var raw = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : "";
  var body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    return jsonOut({ ok: false, error: "json_invalido" });
  }

  if (isWorkerPayload(body)) {
    return workerSave(body);
  }

  var action = String(body.action || body.accion || "").toLowerCase();
  if (action === "quitar" || action === "cancel" || action === "cancelar" || body.quitar === true) {
    return adminQuitar(body);
  }
  if (body.dni && (body.name || body.nombre || body.trabajador) && body.supervisor) {
    return adminAdd(body);
  }
  if (body.dni && (body.date || body.fecha) && !body.payload) {
    return adminQuitar(body);
  }
  return jsonOut({ ok: false, error: "peticion_desconocida" });
}

function isWorkerPayload(body) {
  if (!body || typeof body !== "object") return false;
  if (body.payload && typeof body.payload === "object") return true;
  if (body.clientId && (body.type === "lista" || body.type === "extra" || body.type === "cierre")) return true;
  return false;
}

function workerSave(body) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) {
    return jsonOut({ ok: false, error: "lock_timeout" });
  }
  try {
    var clientId = String(body.clientId || "").trim();
    var cache = CacheService.getScriptCache();
    if (clientId && cache.get("id:" + clientId)) {
      return jsonOut({ ok: true, saved: true, duplicate: true });
    }

    var p = body.payload || {};
    var people = uniquePeople(Array.isArray(p.personas) ? p.personas : []);
    if (people.length > 400) people = people.slice(0, 400);
    var n = people.length ? people.length : Number(p.trabajadores_unicos) || 0;
    var horaG = cell(p.hora_local, 20);
    var fechaHoy = limaFecha();
    var fechaIn = String(p.fecha_local || "").slice(0, 10);
    var fecha = fechaIn === fechaHoy ? fechaIn : fechaHoy;
    var sid = String(p.supervisor_id || "").replace(/\D/g, "").slice(0, 8);
    if (!/^\d{8}$/.test(sid)) {
      return jsonOut({ ok: false, error: "sesion_invalida" });
    }
    var sap = cell(p.supervisor_apellido, 80);
    var comida = cell(p.comida, 40);
    var comedor = canonSede(p.comedor) || cell(p.comedor, 40);
    var etapa = cell(p.etapa, 40);
    var type = String(body.type || "").toLowerCase();
    var extra = type === "extra" || p.extra === true;
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (type === "cierre") {
      if (clientId) cache.put("id:" + clientId, "1", CACHE_TTL_SEC);
      return jsonOut({ ok: true, saved: true, cierre: true, duplicate: false });
    }

    if (!people.length) {
      return jsonOut({ ok: false, error: "sin_personas" });
    }

    var yaEnvio = supervisorYaRegistroHoy(ss, sid, fecha);

    if (extra && !yaEnvio) {
      return jsonOut({
        ok: true,
        saved: true,
        extra: false,
        duplicate: true,
        already: false,
        error: "sin_almuerzo",
        trabajadores: 0,
        total: 0
      });
    }

    if (!extra && yaEnvio) {
      markSupervisorSent(sid, fecha, comida);
      if (clientId) cache.put("id:" + clientId, "1", CACHE_TTL_SEC);
      return jsonOut({
        ok: true,
        saved: true,
        duplicate: true,
        already: true,
        error: "ya_enviado",
        trabajadores: 0,
        total: 0
      });
    }

    if (extra) {
      var packX = ensurePersonSheet(ss, "Comidas extras");
      if (people.length) {
        writePeople(packX, people, {
          fecha: fecha,
          hora: horaG,
          sid: sid,
          sap: sap,
          comida: comida,
          comedor: comedor,
          etapa: etapa,
          extra: true,
          status: "confirmed"
        });
      }
      if (clientId) cache.put("id:" + clientId, "1", CACHE_TTL_SEC);
      bumpAdminCache();
      return jsonOut({
        ok: true,
        saved: true,
        extra: true,
        duplicate: false,
        trabajadores: people.length,
        total: n
      });
    }

    var packT = ensurePersonSheet(ss, "Trabajadores");
    var shS = sheetReady(ss, "Supervisores", COLS_SUPERVISORES);
    if (people.length) {
      writePeople(packT, people, {
        fecha: fecha,
        hora: horaG,
        sid: sid,
        sap: sap,
        comida: comida,
        comedor: comedor,
        etapa: etapa,
        extra: false,
        status: "confirmed"
      });
    }
    shS.appendRow([fecha, horaG, sid, sap, comida, comedor, etapa, n]);
    markSupervisorSent(sid, fecha, comida);
    if (clientId) cache.put("id:" + clientId, "1", CACHE_TTL_SEC);
    bumpAdminCache();
    return jsonOut({
      ok: true,
      saved: true,
      duplicate: false,
      trabajadores: people.length,
      total: n
    });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function adminAdd(body) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) {
    return jsonOut({ ok: false, error: "lock_timeout" });
  }
  try {
    var dni = onlyDni(body.dni || body.documento);
    var name = String(body.name || body.nombre || body.trabajador || "").replace(/\s+/g, " ").trim();
    var supName = String(body.supervisor || body.supervisor_name || body.supervisor_id || "").trim();
    var sup = findSupervisor(supName);
    if (!/^\d{8}$/.test(dni)) return jsonOut({ ok: false, error: "dni_invalido" });
    if (!name) return jsonOut({ ok: false, error: "nombre_invalido" });
    if (!sup) return jsonOut({ ok: false, error: "supervisor_invalido" });

    var fecha = limaFecha();
    var hora = limaHora();
    var sede = canonSede(body.sede || body.comedor || body.hall);
    if (!sede) sede = lastSedeForSupervisor(sup.dni, fecha);
    if (!sede) return jsonOut({ ok: false, error: "comedor_requerido" });
    var parts = splitName(name);
    var active = findActiveSameDay(dni, fecha);
    var extra = active.length > 0;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var pack = ensurePersonSheet(ss, extra ? "Comidas extras" : "Trabajadores");
    var id = newId(extra ? "x" : "t");
    appendReserva(pack, {
      id: id,
      fecha: fecha,
      hora: hora,
      sid: sup.dni,
      sap: twoApellidos(sup.name),
      dni: dni,
      apellido: parts.apellido,
      nombre: parts.nombre,
      comida: "Almuerzo",
      comedor: sede,
      etapa: "",
      status: "confirmed"
    });
    bumpAdminCache();
    return jsonOut({
      ok: true,
      saved: true,
      extra: extra,
      reserva: {
        id: id,
        dni: dni,
        name: name,
        date: fecha,
        time: hora,
        supervisor: sup.name,
        sede: sede,
        extra: extra,
        status: "confirmed"
      }
    });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function adminQuitar(body) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) {
    return jsonOut({ ok: false, error: "lock_timeout" });
  }
  try {
    var dni = onlyDni(body.dni || body.documento);
    var fecha = String(body.date || body.fecha || limaFecha()).slice(0, 10);
    var id = String(body.id || body._id || "").trim();
    if (!id && !/^\d{8}$/.test(dni)) return jsonOut({ ok: false, error: "dni_invalido" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return jsonOut({ ok: false, error: "fecha_invalida" });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var hits = 0;
    hits += cancelInSheet(ensurePersonSheet(ss, "Trabajadores"), dni, fecha, id);
    hits += cancelInSheet(ensurePersonSheet(ss, "Comidas extras"), dni, fecha, id);
    bumpAdminCache();
    return jsonOut({ ok: true, saved: true, cancelled: hits });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function listReservas(desde, hasta) {
  var cache = CacheService.getScriptCache();
  var key = "rsv:" + desde + ":" + hasta;
  var hit = cache.get(key);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { /* sigue */ }
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var list = [];
  list = list.concat(readSheetReservas(ensurePersonSheet(ss, "Trabajadores"), false, desde, hasta));
  list = list.concat(readSheetReservas(ensurePersonSheet(ss, "Comidas extras"), true, desde, hasta));
  list = dedupeActivas(list);
  try { cache.put(key, JSON.stringify(list), ADMIN_CACHE_SEC); } catch (e2) { /* ignore */ }
  return list;
}

function readSheetReservas(pack, fromExtra, desde, hasta) {
  var sh = pack.sh;
  var last = sh.getLastRow();
  if (last < 2) return [];
  var lastCol = Math.max(sh.getLastColumn(), COLS_TRABAJADORES.length);
  var start = Math.max(2, last - 3999);
  var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var fecha = normFecha(val(pack, row, "fecha_local"));
    if (!fecha || fecha < desde || fecha > hasta) continue;
    var dni = onlyDni(val(pack, row, "trabajador_dni"));
    if (!/^\d{8}$/.test(dni)) continue;
    var status = normStatus(val(pack, row, "status"));
    var extra = fromExtra || isExtraFlag(val(pack, row, "extra"));
    if (status === "cancelled") extra = false;
    var sid = onlyDni(val(pack, row, "supervisor_id"));
    var sap = String(val(pack, row, "supervisor_apellido") || "").trim();
    var sede = canonSede(val(pack, row, "comedor"));
    var supervisor = titleCase(sap) || sid;
    if (!supervisor || !sede) continue;
    var apellido = String(val(pack, row, "trabajador_apellido") || "").trim();
    var nombre = String(val(pack, row, "trabajador_nombre") || "").trim();
    var name = (apellido + " " + nombre).replace(/\s+/g, " ").trim();
    if (!name) continue;
    var id = String(val(pack, row, "id") || "").trim();
    if (!id) id = (fromExtra ? "x" : "t") + "-" + (start + i);
    out.push({
      id: id,
      dni: dni,
      name: name,
      date: fecha,
      time: normHora(val(pack, row, "hora_guardado")),
      supervisor: supervisor,
      sede: sede,
      extra: extra,
      status: status
    });
  }
  return out;
}

function dedupeActivas(list) {
  var seen = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (r.status === "cancelled") {
      out.push(r);
      continue;
    }
    var key = r.dni + "|" + r.date;
    if (!seen[key]) {
      seen[key] = true;
      if (r.extra) {
        r = copyRsv(r);
        r.extra = false;
      }
      out.push(r);
    } else {
      r = copyRsv(r);
      r.extra = true;
      out.push(r);
    }
  }
  return out;
}

function copyRsv(r) {
  return {
    id: r.id,
    dni: r.dni,
    name: r.name,
    date: r.date,
    time: r.time,
    supervisor: r.supervisor,
    sede: r.sede,
    extra: r.extra,
    status: r.status
  };
}

function findActiveSameDay(dni, fecha) {
  var all = listReservas(fecha, fecha);
  var hits = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].dni === dni && all[i].date === fecha && all[i].status !== "cancelled") hits.push(all[i]);
  }
  return hits;
}

function cancelInSheet(pack, dni, fecha, id) {
  var sh = pack.sh;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var lastCol = Math.max(sh.getLastColumn(), COLS_TRABAJADORES.length);
  var start = Math.max(2, last - 3999);
  var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
  var colStatus = pack.map.status || lastCol;
  var n = 0;
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var rowFecha = normFecha(val(pack, row, "fecha_local"));
    var rowDni = onlyDni(val(pack, row, "trabajador_dni"));
    var rowId = String(val(pack, row, "id") || "").trim();
    var match = id ? (rowId === id) : (rowDni === dni && rowFecha === fecha);
    if (!match) continue;
    if (normStatus(val(pack, row, "status")) === "cancelled") continue;
    sh.getRange(start + i, colStatus).setValue("cancelled");
    n += 1;
  }
  return n;
}

function turnoStatus(q) {
  var sid = onlyDni(q.supervisor || q.supervisor_id || q.dni);
  if (!/^\d{8}$/.test(sid)) return jsonOut({ ok: false, error: "sesion_invalida" });
  var fecha = String(q.fecha || q.date || limaFecha()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) fecha = limaFecha();
  var comida = cell(q.comida || "Almuerzo", 40);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var enviado = supervisorYaRegistroHoy(ss, sid, fecha);
  if (enviado) markSupervisorSent(sid, fecha, comida);
  return jsonOut({
    ok: true,
    enviado: enviado,
    extra_ok: enviado,
    fecha: fecha,
    supervisor_id: sid,
    comida: comida
  });
}

function supervisorSentKey(sid, fecha, comida) {
  return "supsent:" + fecha + ":" + sid + ":" + fold(comida || "almuerzo");
}

function markSupervisorSent(sid, fecha, comida) {
  try {
    CacheService.getScriptCache().put(supervisorSentKey(sid, fecha, comida), "1", CACHE_TTL_SEC);
  } catch (e) { /* ignore */ }
}

function supervisorYaRegistroHoy(ss, sid, fecha) {
  if (!/^\d{8}$/.test(sid) || !fecha) return false;
  var cache = CacheService.getScriptCache();
  try {
    if (cache.get(supervisorSentKey(sid, fecha, "Almuerzo"))) return true;
  } catch (e) { /* sigue a las hojas */ }
  if (supervisorIdEnHojaSupervisores(ss, sid, fecha)) return true;
  return supervisorSentInPeople(ensurePersonSheet(ss, "Trabajadores"), sid, fecha);
}

function supervisorIdEnHojaSupervisores(ss, sid, fecha) {
  var sh = sheetReady(ss, "Supervisores", COLS_SUPERVISORES);
  var last = sh.getLastRow();
  if (last < 2) return false;
  var lastCol = Math.max(sh.getLastColumn(), COLS_SUPERVISORES.length);
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var colFecha = 1;
  var colSid = 3;
  for (var h = 0; h < headers.length; h++) {
    var key = String(headers[h] || "").toLowerCase().trim();
    if (key === "fecha_local") colFecha = h + 1;
    if (key === "supervisor_id") colSid = h + 1;
  }
  var start = Math.max(2, last - 799);
  var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (normFecha(values[i][colFecha - 1]) !== fecha) continue;
    if (onlyDni(values[i][colSid - 1]) === sid) return true;
  }
  return false;
}

function supervisorSentInPeople(pack, sid, fecha) {
  var sh = pack.sh;
  var last = sh.getLastRow();
  if (last < 2) return false;
  var lastCol = Math.max(sh.getLastColumn(), COLS_TRABAJADORES.length);
  var start = Math.max(2, last - 1199);
  var values = sh.getRange(start, 1, last - start + 1, lastCol).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var row = values[i];
    if (normFecha(val(pack, row, "fecha_local")) !== fecha) continue;
    if (onlyDni(val(pack, row, "supervisor_id")) !== sid) continue;
    if (normStatus(val(pack, row, "status")) === "cancelled") continue;
    return true;
  }
  return false;
}

function writePeople(pack, people, meta) {
  var rows = [];
  for (var i = 0; i < people.length; i++) {
    var w = people[i] || {};
    rows.push(reservaRow(pack, {
      id: newId(meta.extra ? "x" : "t"),
      fecha: meta.fecha,
      hora: meta.hora,
      sid: meta.sid,
      sap: meta.sap,
      dni: cell(w.id || w.dni, 12),
      apellido: cell(w.apellido, 80),
      nombre: cell(w.nombre, 80),
      comida: meta.comida,
      comedor: meta.comedor,
      etapa: meta.etapa,
      status: meta.status || "confirmed"
    }));
  }
  if (!rows.length) return;
  pack.sh.getRange(pack.sh.getLastRow() + 1, 1, rows.length, pack.width).setValues(rows);
}

function appendReserva(pack, rec) {
  pack.sh.getRange(pack.sh.getLastRow() + 1, 1, 1, pack.width).setValues([reservaRow(pack, rec)]);
}

function reservaRow(pack, rec) {
  var row = [];
  for (var i = 0; i < pack.width; i++) row.push("");
  setCol(pack, row, "fecha_local", rec.fecha);
  setCol(pack, row, "hora_guardado", rec.hora);
  setCol(pack, row, "supervisor_id", rec.sid);
  setCol(pack, row, "supervisor_apellido", rec.sap);
  setCol(pack, row, "trabajador_dni", rec.dni);
  setCol(pack, row, "trabajador_apellido", rec.apellido);
  setCol(pack, row, "trabajador_nombre", rec.nombre);
  setCol(pack, row, "comida", rec.comida);
  setCol(pack, row, "comedor", rec.comedor);
  setCol(pack, row, "etapa", rec.etapa);
  setCol(pack, row, "id", rec.id);
  setCol(pack, row, "status", rec.status || "confirmed");
  return row;
}

function setCol(pack, row, name, value) {
  var col = pack.map[name];
  if (!col) return;
  row[col - 1] = value == null ? "" : value;
}

function val(pack, row, name) {
  var col = pack.map[name];
  if (!col) return "";
  return row[col - 1];
}

function ensurePersonSheet(ss, name) {
  var sh = sheetReady(ss, name, COLS_TRABAJADORES);
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var key = String(headers[i] || "").toLowerCase().trim();
    if (key) map[key] = i + 1;
  }
  for (var j = 0; j < COLS_TRABAJADORES.length; j++) {
    var need = COLS_TRABAJADORES[j];
    if (!map[need]) {
      var col = sh.getLastColumn() + 1;
      sh.getRange(1, col).setValue(need).setFontWeight("bold");
      map[need] = col;
    }
  }
  return { sh: sh, map: map, width: sh.getLastColumn() };
}

function supervisorsUrl() {
  try {
    var u = PropertiesService.getScriptProperties().getProperty("SUPERVISORS_URL");
    if (u && String(u).trim()) return String(u).trim();
  } catch (e) { /* default */ }
  return SUPERVISORS_JSON_URL;
}

function loadSupervisors() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get("supcat");
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { /* sigue */ }
  }
  var list = fetchSupervisors();
  try { cache.put("supcat", JSON.stringify(list), SUP_CACHE_SEC); } catch (e2) { /* ignore */ }
  return list;
}

function fetchSupervisors() {
  var data = {};
  try {
    var res = UrlFetchApp.fetch(supervisorsUrl(), {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { "Cache-Control": "no-cache" }
    });
    if (res.getResponseCode() >= 400) return [];
    data = JSON.parse(res.getContentText() || "{}");
  } catch (err) {
    return [];
  }
  var seen = {};
  var list = [];

  function add(dni, nombre, cargo) {
    var id = onlyDni(dni);
    var raw = String(nombre || "").replace(/\s+/g, " ").trim();
    if (!/^\d{8}$/.test(id) || !raw || seen[id]) return;
    seen[id] = true;
    list.push({
      dni: id,
      name: titleCase(raw),
      nombre: raw.toUpperCase(),
      cargo: String(cargo || "")
    });
  }

  var byDni = data.byDni && typeof data.byDni === "object" ? data.byDni : {};
  for (var dni in byDni) {
    if (!byDni.hasOwnProperty(dni)) continue;
    var row = byDni[dni] || {};
    add(dni, row.nombre || row.name, row.cargo);
  }
  var arr = data.supervisores || data.supervisors || [];
  if (Object.prototype.toString.call(arr) === "[object Array]") {
    for (var i = 0; i < arr.length; i++) {
      var s = arr[i] || {};
      add(s.dni || s.id, s.nombre || s.name, s.cargo);
    }
  }
  return list;
}

function findSupervisor(raw) {
  var key = fold(raw);
  if (!key) return null;
  var digits = onlyDni(raw);
  var list = loadSupervisors();
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (digits && s.dni === digits) return s;
    if (fold(s.name) === key) return s;
    if (fold(s.nombre) === key) return s;
    if (fold(twoApellidos(s.name)) === key) return s;
  }
  return null;
}

function lastSedeForSupervisor(dni, fecha) {
  var list = listReservas(fecha, fecha);
  for (var i = list.length - 1; i >= 0; i--) {
    var r = list[i];
    if (r.status === "cancelled") continue;
    var sup = findSupervisor(r.supervisor);
    if (sup && sup.dni === dni && r.sede) return r.sede;
  }
  return "";
}

function dateRangeFromQuery(q) {
  var hoy = limaFecha();
  var ayer = addDays(hoy, -1);
  var fecha = String(q.fecha || q.date || "").slice(0, 10);
  var desde = String(q.desde || q.from || "").slice(0, 10);
  var hasta = String(q.hasta || q.to || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { desde: fecha, hasta: fecha };
  if (/^\d{4}-\d{2}-\d{2}$/.test(desde) && /^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    return desde <= hasta ? { desde: desde, hasta: hasta } : { desde: hasta, hasta: desde };
  }
  return { desde: ayer, hasta: hoy };
}

function limaFecha() {
  return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
}

function limaHora() {
  return Utilities.formatDate(new Date(), TZ, "HH:mm");
}

function addDays(iso, delta) {
  var p = iso.split("-");
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  d.setUTCDate(d.getUTCDate() + delta);
  return Utilities.formatDate(d, "UTC", "yyyy-MM-dd");
}

function normFecha(v) {
  if (Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
  }
  var s = String(v || "").trim();
  var m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

function normHora(v) {
  if (Object.prototype.toString.call(v) === "[object Date]" && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, TZ, "HH:mm");
  }
  var s = String(v || "").trim();
  var m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return limaHora();
  return ("0" + m[1]).slice(-2) + ":" + m[2];
}

function normStatus(v) {
  var s = fold(v);
  if (s === "cancelled" || s === "cancelada" || s === "canceled" || s === "cancelado") return "cancelled";
  if (s === "pending" || s === "pendiente") return "pending";
  return "confirmed";
}

function isExtraFlag(v) {
  if (v === true || v === 1) return true;
  var s = fold(v);
  return s === "true" || s === "1" || s === "si" || s === "extra";
}

function canonSede(raw) {
  var s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  var f = fold(s);
  if (f === "galpon" || f === "comedor galpon") return "Comedor Galpón";
  if (f === "garita 1" || f === "garita1") return "Garita 1";
  if (f === "garita 2" || f === "garita2") return "Garita 2";
  if (f === "administrativo" || f === "comedor administrativo") return "Comedor Administrativo";
  var m = f.match(/^comedor (\d{1,2})$/);
  if (m) {
    var num = Number(m[1]);
    if (num >= 1 && num <= 11) return "Comedor " + num;
  }
  for (var i = 0; i < COMEDORES.length; i++) {
    if (fold(COMEDORES[i]) === f) return COMEDORES[i];
  }
  return s;
}

function uniquePeople(people) {
  var seen = {};
  var out = [];
  for (var i = 0; i < people.length; i++) {
    var w = people[i] || {};
    var d = onlyDni(w.dni || w.id);
    if (!/^\d{8}$/.test(d) || seen[d]) continue;
    seen[d] = true;
    out.push(w);
  }
  return out;
}

function onlyDni(raw) {
  var s = String(raw == null ? "" : raw).replace(/\D/g, "");
  if (s.length >= 8) return s.slice(0, 8);
  return s;
}

function splitName(full) {
  var parts = String(full || "").replace(/\s+/g, " ").trim().split(" ");
  if (parts.length >= 2) {
    return { apellido: (parts[0] + " " + parts[1]).toUpperCase(), nombre: parts.slice(2).join(" ") };
  }
  return { apellido: String(parts[0] || "").toUpperCase(), nombre: "" };
}

function twoApellidos(name) {
  return splitName(name).apellido;
}

function titleCase(s) {
  return String(s || "").toLowerCase().replace(/(^|[\s'])\S/g, function (c) {
    return c.toUpperCase();
  });
}

function fold(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[áàäâ]/g, "a")
    .replace(/[éèëê]/g, "e")
    .replace(/[íìïî]/g, "i")
    .replace(/[óòöô]/g, "o")
    .replace(/[úùüû]/g, "u")
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function newId(prefix) {
  return prefix + "-" + Utilities.formatDate(new Date(), TZ, "yyyyMMddHHmmss") + "-" + String(Math.floor(Math.random() * 9000) + 1000);
}

function bumpAdminCache() {
  try {
    var c = CacheService.getScriptCache();
    var hoy = limaFecha();
    c.remove("rsv:" + hoy + ":" + hoy);
    c.remove("rsv:" + addDays(hoy, -1) + ":" + hoy);
  } catch (e) { /* ignore */ }
}

function cell(v, max) {
  var s = String(v == null ? "" : v);
  s = s.replace(/[\u0000-\u001f]/g, " ").trim();
  if (/^[=+\-@|]/.test(s)) s = "'" + s;
  return s.slice(0, max || 180);
}

function sheetReady(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  sh.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  sh.setFrozenRows(1);
  return sh;
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function textOut(obj) {
  return jsonOut(obj);
}

function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensurePersonSheet(ss, "Trabajadores");
  sheetReady(ss, "Supervisores", COLS_SUPERVISORES);
  ensurePersonSheet(ss, "Comidas extras");
  var shS = ss.getSheetByName("Supervisores");
  shS.getRange(1, 1, 1, COLS_SUPERVISORES.length).setValues([COLS_SUPERVISORES]);
  shS.getRange(1, 1, 1, COLS_SUPERVISORES.length).setFontWeight("bold");
  shS.setFrozenRows(1);
}

function seedDemoData() {
  setupSheets();
  var hoy = limaFecha();
  var ayer = addDays(hoy, -1);
  var cats = loadSupervisors();
  if (!cats.length) throw new Error("No se pudo leer supervisors.json");
  var samples = [
    { dni: "46426978", name: "Burgos Vásquez Ebelio" },
    { dni: "40112233", name: "Lopez Diaz Carla" },
    { dni: "40223344", name: "Ramos Quispe Julio" },
    { dni: "40334455", name: "Torres Vega Ana" },
    { dni: "40445566", name: "Huaman Cruz Pedro" },
    { dni: "40556677", name: "Salazar Pineda Rosa" },
    { dni: "40667788", name: "Cueva Rojas Mario" },
    { dni: "40778899", name: "Nieto Campos Lucia" },
    { dni: "40889900", name: "Paredes Soto Kevin" }
  ];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var packT = ensurePersonSheet(ss, "Trabajadores");
  var packX = ensurePersonSheet(ss, "Comidas extras");

  function put(pack, day, time, sample, extra, status, idx) {
    var sup = cats[idx % cats.length];
    var parts = splitName(sample.name);
    appendReserva(pack, {
      id: newId(extra ? "x" : "t"),
      fecha: day,
      hora: time,
      sid: sup.dni,
      sap: twoApellidos(sup.name),
      dni: sample.dni,
      apellido: parts.apellido,
      nombre: parts.nombre,
      comida: "Almuerzo",
      comedor: COMEDORES[idx % COMEDORES.length],
      etapa: "LICAPA I",
      status: status
    });
  }

  for (var d = 0; d < 2; d++) {
    var day = d === 0 ? hoy : ayer;
    for (var i = 0; i < samples.length; i++) {
      put(packT, day, "06:0" + (i % 6), samples[i], false, "confirmed", i);
    }
    put(packX, day, "07:10", samples[0], true, "confirmed", 0);
    put(packX, day, "07:40", samples[1], true, "confirmed", 1);
    put(packT, day, "08:15", { dni: "40990011", name: "Medina Alva Jorge" }, false, "pending", 4);
    put(packT, day, "05:50", { dni: "40101010", name: "Cancelado Prueba Uno" }, false, "cancelled", 0);
  }
  bumpAdminCache();
}

function verifyDayCounts() {
  var hoy = limaFecha();
  var ayer = addDays(hoy, -1);
  return {
    hoy: tally(listReservas(hoy, hoy)),
    ayer: tally(listReservas(ayer, ayer))
  };
}

function tally(list) {
  var regular = 0;
  var extras = 0;
  var cancelled = 0;
  var pending = 0;
  var bySede = {};
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (r.status === "cancelled") {
      cancelled += 1;
      continue;
    }
    if (r.status === "pending") pending += 1;
    if (r.extra) extras += 1;
    else regular += 1;
    if (!bySede[r.sede]) bySede[r.sede] = 0;
    bySede[r.sede] += 1;
  }
  var prepared = regular + extras;
  var sedeSum = 0;
  for (var k in bySede) {
    if (bySede.hasOwnProperty(k)) sedeSum += bySede[k];
  }
  return {
    regular: regular,
    extras: extras,
    pending: pending,
    cancelled: cancelled,
    prepared: prepared,
    sedeSum: sedeSum,
    ok: prepared === sedeSum
  };
}
