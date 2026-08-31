export function flattenMenu(menu) {
  const items = [];
  for (const cat of menu.categorias || []) {
    for (const it of cat.items || []) {
      items.push({ ...it, grupo: cat.grupo, categoria: cat.nombre, categoriaId: cat.id });
    }
  }
  return items;
}

export function qtyMapFromDraft(draft) {
  return draft?.cantidades && typeof draft.cantidades === "object" ? { ...draft.cantidades } : {};
}

export function sumGroup(items, cantidades, grupo) {
  let n = 0;
  for (const it of items) {
    if (it.grupo !== grupo) continue;
    n += Number(cantidades[it.id] || 0);
  }
  return n;
}

export function detallePlatos(items, cantidades) {
  return items
    .filter((it) => Number(cantidades[it.id] || 0) > 0)
    .map((it) => `${it.nombre} x${Number(cantidades[it.id])}`)
    .join("; ");
}

export function platoPrincipal(items, cantidades) {
  const first = items.find((it) => it.grupo === "A" && Number(cantidades[it.id] || 0) > 0);
  return first ? first.nombre : "";
}

export function porcentaje(conteo, muestra) {
  const c = Number(conteo) || 0;
  const m = Number(muestra) || 0;
  if (m <= 0) return 0;
  return Math.round((c / m) * 10000) / 100;
}

export function completeCounts({ cantA, cantB, pctA, pctB, muestra }) {
  const m = Number(muestra) > 0 ? Number(muestra) : 1;
  const hasA = cantA !== "" && cantA !== null && cantA !== undefined;
  const hasB = cantB !== "" && cantB !== null && cantB !== undefined;
  const hasPA = pctA !== "" && pctA !== null && pctA !== undefined;
  const hasPB = pctB !== "" && pctB !== null && pctB !== undefined;

  const a = hasA ? Number(cantA) || 0 : hasPA ? Math.round((Number(pctA) * m) / 100) : 0;
  const b = hasB ? Number(cantB) || 0 : hasPB ? Math.round((Number(pctB) * m) / 100) : 0;
  const pa = hasPA ? Number(pctA) || 0 : porcentaje(a, m);
  const pb = hasPB ? Number(pctB) || 0 : porcentaje(b, m);
  const total = a + b;
  return {
    cant_grupo_a: a,
    cant_grupo_b: b,
    pct_grupo_a: pa,
    pct_grupo_b: pb,
    total_items: total,
    pct_total: porcentaje(total, m),
    tamano_muestra: m,
  };
}

export function computeOrder(items, cantidades, opts = {}) {
  const muestra = Number(opts.muestra) > 0 ? Number(opts.muestra) : 1;
  const rawA = sumGroup(items, cantidades, "A");
  const rawB = items.some((i) => i.grupo === "B") ? sumGroup(items, cantidades, "B") : 0;
  const hasData = Object.values(cantidades).some((v) => Number(v) > 0);
  const counts = completeCounts({
    cantA: rawA,
    cantB: rawB,
    pctA: null,
    pctB: null,
    muestra,
  });
  return {
    ...counts,
    hasData,
    platos_detalle: detallePlatos(items, cantidades),
    plato_principal: platoPrincipal(items, cantidades),
  };
}

export function computeHeadcount(records) {
  const workers = new Set();
  let enviados = 0;
  let pendientes = 0;
  for (const r of records) {
    if (r.type === "lista" || r.type === "cierre") continue;
    if (r.status === "enviado") enviados += 1;
    else pendientes += 1;
    if (r.payload?.trabajador_id) workers.add(r.payload.trabajador_id);
  }
  return {
    hasData: workers.size > 0,
    trabajadores_unicos: workers.size,
    pedidos_enviados: enviados,
    pedidos_pendientes: pendientes,
  };
}

export function computeDayTotals(records, items, expectedHeadcount) {
  const cantidades = {};
  let enviados = 0;
  let pendientes = 0;
  const workers = new Set();
  for (const r of records) {
    if (r.type === "lista" || r.type === "cierre") continue;
    if (r.status === "enviado") enviados += 1;
    else pendientes += 1;
    if (r.payload?.trabajador_id) workers.add(r.payload.trabajador_id);
    const q = r.payload?.cantidades || {};
    for (const [id, n] of Object.entries(q)) {
      cantidades[id] = (cantidades[id] || 0) + (Number(n) || 0);
    }
  }
  const muestra = Number(expectedHeadcount) > 0 ? Number(expectedHeadcount) : Math.max(workers.size, 1);
  const hasData = enviados + pendientes > 0;
  const calc = computeOrder(items, cantidades, { muestra });
  return {
    ...calc,
    hasData,
    trabajadores_unicos: workers.size,
    pedidos_enviados: enviados,
    pedidos_pendientes: pendientes,
    cantidades,
    tamano_muestra: muestra,
  };
}
