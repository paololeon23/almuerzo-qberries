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

function labelW(label) {
  return String(label || "").length * 6.2 + 8;
}

function buildPdf(model) {
  const W = 595;
  const H = 842;
  const margin = 48;
  const headerH = 62;
  const lineH = 18;
  const footerH = 40;
  const people = Array.isArray(model.people) ? model.people : [];

  function lineFit(usedTop) {
    return Math.max(6, Math.floor((H - usedTop - footerH) / lineH));
  }

  const infoLines = 8;
  const firstTop = headerH + 28 + infoLines * lineH + 10;
  const nextTop = headerH + 28;
  const pages = [];
  const rest = people.slice();
  pages.push({ rows: rest.splice(0, lineFit(firstTop)), hasInfo: true });
  while (rest.length) pages.push({ rows: rest.splice(0, lineFit(nextTop)), hasInfo: false });

  function pair(s, x, y, label, value) {
    s.push("0.106 0.122 0.141 rg");
    s.push("BT /F2 10 Tf " + x + " " + y + " Td (" + pdfEscape(label) + ") Tj ET");
    s.push("BT /F1 10 Tf " + (x + labelW(label)) + " " + y + " Td (" + pdfEscape(value) + ") Tj ET");
  }

  function pageStream(page, pageIndex) {
    const s = [];
    const isLast = pageIndex === pages.length - 1;
    s.push("0.247 0.529 0.212 rg 0 " + (H - headerH) + " " + W + " " + headerH + " re f");
    s.push("1 1 1 rg");
    s.push("BT /F2 16 Tf 48 " + (H - 28) + " Td (" + pdfEscape("Q BERRIES") + ") Tj ET");
    s.push("BT /F1 10 Tf 48 " + (H - 46) + " Td (" + pdfEscape("Solicitud de almuerzo  -  documento de seguridad") + ") Tj ET");
    s.push("BT /F1 9 Tf 470 " + (H - 36) + " Td (" + pdfEscape("Pagina " + (pageIndex + 1) + " / " + pages.length) + ") Tj ET");

    let y = H - headerH - 26;
    if (page.hasInfo) {
      pair(s, margin, y, "SUPERVISOR:", clip(model.supervisor, 48));
      y -= lineH;
      pair(s, margin, y, "DNI:", String(model.supervisorDni || "—"));
      pair(s, 280, y, "TIPO:", String(model.tipo || "Lista"));
      y -= lineH;
      pair(s, margin, y, "FECHA:", String(model.fecha || "—"));
      pair(s, 280, y, "HORA:", String(model.hora || "—"));
      y -= lineH;
      pair(s, margin, y, "ETAPA:", String(model.etapa || "—"));
      pair(s, 280, y, "COMEDOR:", String(model.comedor || "—"));
      y -= lineH;
      pair(s, margin, y, "COMIDA:", String(model.comida || "Almuerzo"));
      pair(s, 280, y, "CANTIDAD:", String(model.cantidad ?? 0));
      y -= lineH;
      pair(s, margin, y, "FUNDO:", clip(model.fundo, 40));
      pair(s, 280, y, "ESTADO:", String(model.estado || ""));
      y -= lineH + 8;
      s.push("0.247 0.529 0.212 rg");
      s.push("BT /F2 10 Tf " + margin + " " + y + " Td (" + pdfEscape("PERSONAS") + ") Tj ET");
      y -= lineH + 4;
    } else {
      pair(s, margin, y, "CONTINUACION:", clip(model.supervisor, 42));
      y -= lineH + 6;
    }

    page.rows.forEach((row) => {
      const n = String(row.n || "").padStart(2, " ");
      const line = n + ".  DNI " + (row.dni || "—") + "   " + clip(row.nombre, 42) + "   Menus: " + (row.menus || 1);
      s.push("0.106 0.122 0.141 rg");
      s.push("BT /F1 10 Tf " + margin + " " + y + " Td (" + pdfEscape(line) + ") Tj ET");
      y -= lineH;
    });

    if (isLast) {
      y -= 6;
      pair(s, margin, y, "TOTAL:", String(model.cantidad ?? 0));
    }

    s.push("0.42 0.45 0.49 rg");
    s.push("BT /F1 8 Tf 48 22 Td (" + pdfEscape("Generado en el celular, sin internet. Conservar para cocina / seguridad.") + ") Tj ET");
    return s.join("\n");
  }

  const objects = [];
  objects.push("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push(`2 0 obj << /Type /Pages /Kids [${kids}] /Count ${pages.length} >> endobj\n`);
  const font1 = 3 + pages.length * 2;
  const font2 = font1 + 1;
  pages.forEach((page, i) => {
    const pageId = 3 + i * 2;
    const contentId = pageId + 1;
    const stream = pageStream(page, i);
    objects.push(
      `${pageId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> /Contents ${contentId} 0 R >> endobj\n`
    );
    objects.push(`${contentId} 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`);
  });
  objects.push(`${font1} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj\n`);
  objects.push(`${font2} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >> endobj\n`);

  const xref = [];
  let body = "%PDF-1.4\n";
  let pos = body.length;
  objects.forEach((obj) => {
    xref.push(pos);
    body += obj;
    pos = body.length;
  });
  const xrefStart = body.length;
  let xrefBlock = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  xref.forEach((p) => {
    xrefBlock += `${(`0000000000${p}`).slice(-10)} 00000 n \n`;
  });
  body += `${xrefBlock}trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new Blob([body], { type: "application/pdf" });
}

export function histPdfFileName(model) {
  const day = String(model.fechaIso || "").slice(0, 10) || "almuerzo";
  const hall = String(model.comedorN || "comedor").replace(/\s+/g, "");
  return `QBerries_${day}_C${hall}.pdf`;
}

export function histShareText(model) {
  return [
    "Q BERRIES — Solicitud de almuerzo",
    `SUPERVISOR : ${model.supervisor || "—"}`,
    "----------------------------------",
    `FECHA : ${model.fecha || "—"}`,
    `HORA : ${model.hora || "—"}`,
    `ETAPA : ${model.etapa || "—"}`,
    `COMEDOR : ${model.comedorN || model.comedor || "—"}`,
    `COMIDA : ${model.comida || "Almuerzo"}`,
    `CANTIDAD: ${model.cantidad ?? 0}`,
    `TIPO : ${model.tipo || "Lista"}`,
    `ESTADO : ${model.estado || ""}`,
    "----------------------------------",
    `TOTAL : ${model.cantidad ?? 0}`,
  ].join("\n");
}

export function histPdfBlob(model) {
  return buildPdf(model || {});
}
