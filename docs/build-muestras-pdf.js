const fs = require("fs");
const path = require("path");

function pdfEscape(str) {
  let out = "";
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 40 || c === 41 || c === 92) out += `\\${s.charAt(i)}`;
    else if (c === 0x2013 || c === 0x2014) out += "-";
    else if (c === 0x00b7) out += "\\267";
    else if (c >= 32 && c <= 126) out += s.charAt(i);
    else if (c > 127 && c < 256) out += `\\${(`00${c.toString(8)}`).slice(-3)}`;
    else out += "?";
  }
  return out;
}

function clip(str, max) {
  const s = String(str || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}.` : s;
}

function centerX(x, w, text, charW) {
  const tw = String(text || "").length * charW;
  const tx = x + (w - tw) / 2;
  return tx < x + 4 ? x + 4 : tx;
}

const people = [
  ["18137839", "CABREJOS BOBADILLA ANA CECILIA"],
  ["75663008", "RUBIO VASQUEZ ANGEL GRABIEL"],
  ["60546128", "REQUELME REYES JEISON DAN"],
  ["73706662", "ALCALDE RUIZ FLAVIO CESAR"],
  ["60740851", "HORNA JUAREZ ROSALINA NOEMI"],
  ["41308562", "GONZALEZ LEZAMA MARILU JANETH"],
  ["47399458", "RONDON GARCIA TANIA ELIZABETH"],
  ["71284526", "GONZALES HUACCHA ALEX ADRIAN"],
  ["76463805", "ANGULO DIAZ MARIA ELENA"],
  ["80194059", "ALVA PERALTA SEGUNDO ALFONSO"],
  ["75141739", "ROJAS AREDO YERSI YEN"],
  ["70996432", "DE LA CRUZ HERMENEGILDO DELIN RAQUEL"],
  ["76628888", "RODRIGUEZ PAREDES RONAL"],
  ["74378171", "CAMPOS GUEVARA CARMEN"],
  ["18172313", "MARQUINA VERGARA JULIO CESAR"],
  ["74021884", "TORRES TORRES SHIRLEY LLERUCSA"],
  ["76292607", "QUISPE RODRIGUEZ MICHAEL JUNIOR"],
  ["45082755", "AGUIRRE CARDENAS JUANA ROSA"],
  ["72580404", "PEREZ PONCE SAYRA BETSABE"],
  ["75748942", "GARCIA FLORES ANGEL ANTONIO"],
];

const W = 595;
const H = 842;
const margin = 42;
const headerH = 70;
const tableW = W - margin * 2;
const rowH = 20;
const colHeadH = 24;
const cols = [
  { key: "n", label: "N", x: margin, w: 36, center: true },
  { key: "dni", label: "DNI", x: margin + 36, w: 92, center: true },
  { key: "nombre", label: "APELLIDOS Y NOMBRES", x: margin + 128, w: tableW - 128, center: false },
];

const s = [];
s.push("0.247 0.529 0.212 rg 0 " + (H - headerH) + " " + W + " " + headerH + " re f");
s.push("1 1 1 rg");
s.push("BT /F2 18 Tf 42 " + (H - 30) + " Td (" + pdfEscape("Q BERRIES") + ") Tj ET");
s.push("BT /F1 10 Tf 42 " + (H - 48) + " Td (" + pdfEscape("Solicitud de almuerzo  -  muestras para prueba") + ") Tj ET");
s.push("BT /F1 9 Tf 430 " + (H - 38) + " Td (" + pdfEscape("Uso interno") + ") Tj ET");

let y = H - headerH - 22;
s.push("0.965 0.93 0.86 rg " + margin + " " + (y - 52) + " " + tableW + " 58 re f");
s.push("0.85 0.62 0.16 RG 0.9 w " + margin + " " + (y - 52) + " " + tableW + " 58 re S");
s.push("0.106 0.122 0.141 rg");
s.push("BT /F2 9 Tf " + (margin + 12) + " " + (y - 8) + " Td (" + pdfEscape("CONFIDENCIAL") + ") Tj ET");
s.push("BT /F1 9 Tf " + (margin + 12) + " " + (y - 22) + " Td (" + pdfEscape("Se trabaja con datos de trabajadores. Usar solo de manera local.") + ") Tj ET");
s.push("BT /F1 9 Tf " + (margin + 12) + " " + (y - 36) + " Td (" + pdfEscape("No compartir este documento ni difundir los DNI fuera de la prueba.") + ") Tj ET");
y -= 74;

s.push("0.247 0.529 0.212 rg");
s.push("BT /F2 11 Tf " + margin + " " + y + " Td (" + pdfEscape("Acceso a la app") + ") Tj ET");
y -= 18;
s.push("0.106 0.122 0.141 rg");
s.push("BT /F2 10 Tf " + margin + " " + y + " Td (" + pdfEscape("DNI") + ") Tj ET");
s.push("BT /F1 10 Tf " + (margin + 70) + " " + y + " Td (" + pdfEscape("12345678") + ") Tj ET");
s.push("BT /F2 10 Tf " + 280 + " " + y + " Td (" + pdfEscape("NOMBRE") + ") Tj ET");
s.push("BT /F1 10 Tf " + 350 + " " + y + " Td (" + pdfEscape("PRUEBA ALZA") + ") Tj ET");
y -= 16;
s.push("0.42 0.45 0.49 rg");
s.push("BT /F1 9 Tf " + margin + " " + y + " Td (" + pdfEscape("Escriba o escanee ese DNI para entrar y pedir almuerzo.") + ") Tj ET");
y -= 26;

s.push("0.247 0.529 0.212 rg");
s.push("BT /F2 11 Tf " + margin + " " + y + " Td (" + pdfEscape("20 trabajadores para ensayar la lista") + ") Tj ET");
y -= 16;
s.push("0.42 0.45 0.49 rg");
s.push("BT /F1 9 Tf " + margin + " " + y + " Td (" + pdfEscape("DNI reales de la base. Escanear o escribir para solicitar almuerzo.") + ") Tj ET");
y -= 18;

const tableH = colHeadH + people.length * rowH;
const tableY = y - tableH;
s.push("0.247 0.529 0.212 rg " + margin + " " + (y - colHeadH) + " " + tableW + " " + colHeadH + " re f");
s.push("1 1 1 rg");
cols.forEach((col) => {
  const tx = col.center ? centerX(col.x, col.w, col.label, 5) : col.x + 10;
  s.push("BT /F2 8 Tf " + tx.toFixed(1) + " " + (y - colHeadH + 8) + " Td (" + pdfEscape(col.label) + ") Tj ET");
});

people.forEach((row, i) => {
  const ry = y - colHeadH - (i + 1) * rowH;
  if (i % 2 === 1) s.push("0.945 0.969 0.941 rg " + margin + " " + ry + " " + tableW + " " + rowH + " re f");
  const n = String(i + 1);
  s.push("0.106 0.122 0.141 rg");
  s.push("BT /F1 9 Tf " + centerX(cols[0].x, cols[0].w, n, 5.2).toFixed(1) + " " + (ry + 6) + " Td (" + pdfEscape(n) + ") Tj ET");
  s.push("BT /F1 9 Tf " + centerX(cols[1].x, cols[1].w, row[0], 5.2).toFixed(1) + " " + (ry + 6) + " Td (" + pdfEscape(row[0]) + ") Tj ET");
  s.push("BT /F1 9 Tf " + (cols[2].x + 10) + " " + (ry + 6) + " Td (" + pdfEscape(clip(row[1], 42)) + ") Tj ET");
});

s.push("0.247 0.529 0.212 RG 0.8 w");
s.push(margin + " " + tableY + " " + tableW + " " + tableH + " re S");
let vx = margin;
cols.forEach((col, i) => {
  if (i) s.push(vx + " " + tableY + " m " + vx + " " + (tableY + tableH) + " l S");
  vx += col.w;
});
let hy = y - colHeadH;
for (let i = 0; i < people.length; i += 1) {
  s.push(margin + " " + hy + " m " + (margin + tableW) + " " + hy + " l S");
  hy -= rowH;
}

s.push("0.42 0.45 0.49 rg");
s.push("BT /F1 8 Tf 42 26 Td (" + pdfEscape("Q BERRIES  -  documento de prueba. No difundir. Conservar de manera local.") + ") Tj ET");

const stream = s.join("\n");
const objects = [];
objects.push("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
objects.push("2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n");
objects.push("3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >> endobj\n");
objects.push("4 0 obj << /Length " + stream.length + " >> stream\n" + stream + "\nendstream endobj\n");
objects.push("5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj\n");
objects.push("6 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >> endobj\n");

const xref = [];
let body = "%PDF-1.4\n";
let pos = body.length;
objects.forEach((obj) => {
  xref.push(pos);
  body += obj;
  pos = body.length;
});
const xrefStart = body.length;
let xrefBlock = "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
xref.forEach((p) => {
  xrefBlock += (("0000000000" + p).slice(-10)) + " 00000 n \n";
});
body += xrefBlock + "trailer << /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF";

const out = path.join(__dirname, "Muestras_Prueba_Almuerzo.pdf");
fs.writeFileSync(out, body, "ascii");
console.log(out);
