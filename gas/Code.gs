/**
 * Cocina QBerries — Google Apps Script
 * Pegar en Extensiones → Apps Script. Implementar como Web App.
 *
 * Hojas:
 *   Trabajadores — uno por persona, enlazado al supervisor
 *   Supervisores  — un renglón por envío, con el total de comidas
 *   Comidas extras — olvidados o tardanzas (después del primer envío)
 * hora_guardado = hora del celular (payload.hora_local). No se guarda client_id.
 */

var CACHE_TTL_SEC = 21600;
var APP_VERSION = "1.0.0";
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
  "lote"
];

var COLS_SUPERVISORES = [
  "fecha_local",
  "hora_guardado",
  "supervisor_id",
  "supervisor_apellido",
  "comida",
  "comedor",
  "lote",
  "total_comidas"
];

function doGet() {
  return textOut({
    ok: true,
    ping: true,
    version: APP_VERSION,
    app: "Cocina QBerries",
    time: new Date().toISOString()
  });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) {
    return textOut({ ok: false, error: "lock_timeout" });
  }

  try {
    var raw = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : "";
    var body = {};
    try {
      body = JSON.parse(raw);
    } catch (err) {
      return textOut({ ok: false, error: "json_invalido" });
    }

    var clientId = String(body.clientId || "").trim();
    var cache = CacheService.getScriptCache();
    if (clientId && cache.get("id:" + clientId)) {
      return textOut({ ok: true, saved: true, duplicate: true });
    }

    var p = body.payload || {};
    var people = Array.isArray(p.personas) ? p.personas : [];
    if (people.length > 400) people = people.slice(0, 400);
    var n = people.length ? people.length : Number(p.trabajadores_unicos) || 0;
    var horaG = cell(p.hora_local, 20);
    var fecha = cell(p.fecha_local, 12);
    var sid = String(p.supervisor_id || "").replace(/\D/g, "").slice(0, 8);
    if (!/^\d{8}$/.test(sid)) {
      return textOut({ ok: false, error: "sesion_invalida" });
    }
    var sap = cell(p.supervisor_apellido, 80);
    var comida = cell(p.comida, 40);
    var comedor = cell(p.comedor, 40);
    var lote = cell(p.lote || p.lote_codigo, 80);

    var extra = body.type === "extra" || p.extra === true;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (extra) {
      var shX = sheetReady(ss, "Comidas extras", COLS_TRABAJADORES);
      if (people.length) {
        var extraRows = [];
        for (var j = 0; j < people.length; j++) {
          var x = people[j] || {};
          extraRows.push([
            fecha,
            horaG,
            sid,
            sap,
            cell(x.id || x.dni, 12),
            cell(x.apellido, 80),
            cell(x.nombre, 80),
            comida,
            comedor,
            lote
          ]);
        }
        shX.getRange(shX.getLastRow() + 1, 1, extraRows.length, COLS_TRABAJADORES.length).setValues(extraRows);
      }
      if (clientId) cache.put("id:" + clientId, "1", CACHE_TTL_SEC);
      return textOut({
        ok: true,
        saved: true,
        extra: true,
        duplicate: false,
        trabajadores: people.length,
        total: n
      });
    }

    var shT = sheetReady(ss, "Trabajadores", COLS_TRABAJADORES);
    var shS = sheetReady(ss, "Supervisores", COLS_SUPERVISORES);

    if (people.length) {
      var rows = [];
      for (var i = 0; i < people.length; i++) {
        var w = people[i] || {};
        rows.push([
          fecha,
          horaG,
          sid,
          sap,
          cell(w.id || w.dni, 12),
          cell(w.apellido, 80),
          cell(w.nombre, 80),
          comida,
          comedor,
          lote
        ]);
      }
      shT.getRange(shT.getLastRow() + 1, 1, rows.length, COLS_TRABAJADORES.length).setValues(rows);
    }

    shS.appendRow([
      fecha,
      horaG,
      sid,
      sap,
      comida,
      comedor,
      lote,
      n
    ]);

    if (clientId) cache.put("id:" + clientId, "1", CACHE_TTL_SEC);
    return textOut({
      ok: true,
      saved: true,
      duplicate: false,
      trabajadores: people.length,
      total: n
    });
  } catch (err) {
    return textOut({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
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

function textOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.TEXT);
}

function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  sheetReady(ss, "Trabajadores", COLS_TRABAJADORES);
  sheetReady(ss, "Supervisores", COLS_SUPERVISORES);
  sheetReady(ss, "Comidas extras", COLS_TRABAJADORES);
  var shT = ss.getSheetByName("Trabajadores");
  var shS = ss.getSheetByName("Supervisores");
  var shX = ss.getSheetByName("Comidas extras");
  shT.getRange(1, 1, 1, COLS_TRABAJADORES.length).setValues([COLS_TRABAJADORES]);
  shS.getRange(1, 1, 1, COLS_SUPERVISORES.length).setValues([COLS_SUPERVISORES]);
  shX.getRange(1, 1, 1, COLS_TRABAJADORES.length).setValues([COLS_TRABAJADORES]);
  shT.getRange(1, 1, 1, COLS_TRABAJADORES.length).setFontWeight("bold");
  shS.getRange(1, 1, 1, COLS_SUPERVISORES.length).setFontWeight("bold");
  shX.getRange(1, 1, 1, COLS_TRABAJADORES.length).setFontWeight("bold");
  shT.setFrozenRows(1);
  shS.setFrozenRows(1);
  shX.setFrozenRows(1);
}
