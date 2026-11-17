// Descarga los feeds GTFS-Realtime de Renfe, filtra Asturias y guarda data/trenes.json
// Se ejecuta en GitHub Actions (Node 20, sin dependencias).

const fs = require("fs");
const path = require("path");

const FEEDS = {
  vp:   "https://gtfsrt.renfe.com/vehicle_positions.json",
  tu:   "https://gtfsrt.renfe.com/trip_updates.json",
  vpld: "https://gtfsrt.renfe.com/vehicle_positions_LD.json",
  tuld: "https://gtfsrt.renfe.com/trip_updates_LD.json"
};

const LAT_MIN = 42.70, LAT_MAX = 43.85, LON_MIN = -7.30, LON_MAX = -4.30;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function descargar(clave, intentos = 3) {
  let ultimo = "";
  for (let i = 1; i <= intentos; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(FEEDS[clave], {
        signal: ctrl.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          "Accept": "application/json"
        }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = JSON.parse(await r.text());
      console.log(`[${clave}] OK - ${(json.entity || []).length} entidades`);
      return json;
    } catch (e) {
      ultimo = e.name === "AbortError" ? "tiempo agotado (20 s)" : e.message;
      console.log(`[${clave}] intento ${i}/${intentos} fallido: ${ultimo}`);
      if (i < intentos) await esperar(3000);
    } finally {
      clearTimeout(timer);
    }
  }
  console.log(`[${clave}] FALLO definitivo: ${ultimo}`);
  return null;
}

function extraerPosiciones(feed, prefijo) {
  const lista = [];
  for (const ent of feed?.entity || []) {
    const veh = ent?.vehicle;
    if (!veh || !veh.position) continue;
    const lat = Number(veh.position.latitude);
    const lon = Number(veh.position.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) continue;

    const trip = veh.trip || {};
    const desc = veh.vehicle || {};
    const id = String(desc.id || ent.id || "");
    if (!id) continue;

    lista.push({
      id: prefijo + id,
      etiqueta: String(desc.label || ""),
      viajeId: String(trip.tripId ?? trip.trip_id ?? ""),
      rutaId: String(trip.routeId ?? trip.route_id ?? ""),
      lat,
      lon,
      timestamp: Number(veh.timestamp || 0)
    });
  }
  return lista;
}

function extraerRetrasos(feed, destino) {
  for (const ent of feed?.entity || []) {
    const tu = ent?.tripUpdate || ent?.trip_update;
    if (!tu) continue;
    const trip = tu.trip || {};
    const viajeId = String(trip.tripId ?? trip.trip_id ?? "");
    if (!viajeId) continue;

    let seg = tu.delay != null ? Number(tu.delay) : null;
    if (seg === null || !Number.isFinite(seg)) {
      seg = null;
      for (const stu of tu.stopTimeUpdate || tu.stop_time_update || []) {
        const a = stu?.arrival?.delay;
        const d = stu?.departure?.delay;
        if (a != null && Number.isFinite(Number(a))) { seg = Number(a); break; }
        if (d != null && Number.isFinite(Number(d))) { seg = Number(d); break; }
      }
    }
    if (seg !== null && Number.isFinite(seg)) destino[viajeId] = seg;
  }
}

(async () => {
  const vp = await descargar("vp");
  const vpld = await descargar("vpld");

  if (!vp && !vpld) {
    console.error("\nNo se pudo descargar ningun feed de posiciones. Renfe no responde a esta conexion.");
    process.exit(1);
  }

  const tu = await descargar("tu");
  const tuld = await descargar("tuld");

  const posiciones = [
    ...extraerPosiciones(vp, ""),
    ...extraerPosiciones(vpld, "LD-")
  ];

  const retrasosTodos = {};
  extraerRetrasos(tu, retrasosTodos);
  extraerRetrasos(tuld, retrasosTodos);

  // Solo guardamos los retrasos de los trenes que estan en Asturias
  const retrasos = {};
  for (const p of posiciones) {
    if (p.viajeId && retrasosTodos[p.viajeId] !== undefined) {
      retrasos[p.viajeId] = retrasosTodos[p.viajeId];
    }
  }

  const salida = {
    fetchedAt: Math.floor(Date.now() / 1000),
    posiciones,
    retrasos,
    fuentes: { vp: !!vp, vpld: !!vpld, tu: !!tu, tuld: !!tuld }
  };

  const ruta = path.join(__dirname, "..", "data", "trenes.json");
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, JSON.stringify(salida));
  console.log(`\nGuardado data/trenes.json: ${posiciones.length} trenes en Asturias, ${Object.keys(retrasos).length} con retraso conocido.`);
})();
