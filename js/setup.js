import { encodeQr, normalizeDni } from "./config.js";
import { store } from "./store.js";

function badge(kind, person) {
  const dni = normalizeDni(person.dni || person.id);
  const payload = encodeQr(kind, person);
  const qr = window.qrcode(0, "M");
  qr.addData(payload);
  qr.make();
  const svg = qr.createSvgTag({ scalable: true, margin: 1 });
  const role = person.cargo || (kind === "sup" ? "SUPERVISOR" : "OBRERO");
  const full = person.nombreCompleto || [person.apellido, person.nombre].filter(Boolean).join(" ");
  return `<article class="badge">
    ${svg}
    <small>${escapeHtml(role)}</small>
    <b>${escapeHtml(full)}</b>
    <div>DNI ${escapeHtml(dni)}</div>
  </article>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function loadJson(path, fallback) {
  try {
    const res = await fetch(path, { cache: "no-store" });
    return await res.json();
  } catch {
    return fallback;
  }
}

function render(sups, wrks) {
  document.getElementById("sups").innerHTML = sups.map((p) => badge("sup", p)).join("");
  document.getElementById("wrks").innerHTML = wrks.map((p) => badge("wrk", p)).join("");
}

const fileSup = await loadJson("./data/supervisors.json", { byDni: {}, supervisores: [] });
const fileWrk = await loadJson("./data/trabajadores.json", []);
const rows = Array.isArray(fileWrk) ? fileWrk : fileWrk.trabajadores || [];
const fromByDni = Object.entries(fileSup.byDni || {}).map(([dni, row]) => ({
  dni,
  nombre: row.nombre,
  cargo: row.cargo || "SUPERVISOR DE COSECHA",
}));
const sups = [...store.getLocalSupervisors(), ...fromByDni, ...(fileSup.supervisores || [])]
  .filter((p, i, a) => a.findIndex((x) => (x.dni || x.id) === (p.dni || p.id)) === i);
const wrks = [...store.getLocalWorkers(), ...rows]
  .filter((p, i, a) => a.findIndex((x) => (x.dni || x.id) === (p.dni || p.id)) === i);

render(sups, wrks);

document.getElementById("printBtn").addEventListener("click", () => window.print());
document.getElementById("addBtn").addEventListener("click", () => {
  const kind = prompt("¿supervisor o trabajador?", "trabajador");
  if (!kind) return;
  const apellido = (prompt("Primer apellido") || "").trim().toUpperCase();
  const nombre = (prompt("Nombre") || "").trim();
  const id = (prompt("Código", kind.startsWith("s") ? `S${Date.now().toString().slice(-4)}` : `W${Date.now().toString().slice(-4)}`) || "").trim();
  const area = kind.startsWith("s") ? "" : (prompt("Área") || "").trim();
  if (!id || !apellido) return;
  if (kind.startsWith("s")) {
    store.upsertLocalSupervisor({ id, apellido, nombre });
    sups.unshift({ id, apellido, nombre });
  } else {
    store.upsertLocalWorker({ id, apellido, nombre, area });
    wrks.unshift({ id, apellido, nombre, area });
  }
  render(sups, wrks);
});
