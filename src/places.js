const OVERPASS = "https://overpass.kumi.systems/api/interpreter";
const FETCH_MS = 6000;
const PLAN_MS = 9000;

const QUERIES = {
  cafe: (lat, lon, r) => `[out:json][timeout:5];(node["amenity"="cafe"](around:${r},${lat},${lon}););out center 5;`,
  bench: (lat, lon, r) => `[out:json][timeout:5];(node["amenity"="bench"](around:${r},${lat},${lon});node["leisure"="park"](around:${r},${lat},${lon}););out center 5;`,
  water: (lat, lon, r) => `[out:json][timeout:5];(node["amenity"="fountain"](around:${r},${lat},${lon}););out center 5;`,
};

function distM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function walkMin(meters) {
  return Math.max(1, Math.round(meters / 80));
}

export function mapsSearchLink(query, origin) {
  const q = encodeURIComponent(query);
  if (!origin) return `https://www.google.com/maps/search/${q}`;
  return `https://www.google.com/maps/search/${q}/@${origin.lat},${origin.lon},16z`;
}

function mapsPlaceLink(lat, lon, name) {
  const q = encodeURIComponent(name || `${lat},${lon}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}&query_lat=${lat}&query_lon=${lon}`;
}

function defaultName(category) {
  if (category === "cafe") return "кав’ярня поруч";
  if (category === "bench") return "лавка або парк поруч";
  if (category === "water") return "вода поруч";
  return "місце поруч";
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(FETCH_MS),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

function normalizeElement(el, origin, category) {
  const lat = el.lat || el.center?.lat;
  const lon = el.lon || el.center?.lon;
  if (!lat || !lon) return null;
  const name = el.tags?.name || el.tags?.["name:uk"] || null;
  const meters = Math.round(distM(origin, { lat, lon }));
  return {
    name: name || defaultName(category),
    lat,
    lon,
    meters,
    minutes: walkMin(meters),
    maps: mapsPlaceLink(lat, lon, name),
    category,
    exact: Boolean(name),
  };
}

async function overpassSearch(category, lat, lon, radius) {
  const builder = QUERIES[category];
  if (!builder) return [];
  const json = await fetchJson(OVERPASS, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "User-Agent": "adventure-engine/0.3",
    },
    body: builder(lat, lon, radius),
  });
  const origin = { lat, lon };
  return (json.elements || [])
    .map((el) => normalizeElement(el, origin, category))
    .filter(Boolean)
    .sort((a, b) => a.meters - b.meters);
}

export function formatPlaceLine(place) {
  if (!place) return "";
  return `${place.name}. Приблизно ${place.minutes} хв пішки від старту.`;
}

export function fallbackMapsQuery(category) {
  if (category === "cafe") return "кафе";
  if (category === "bench") return "парк";
  if (category === "water") return "фонтан";
  return "місце";
}

async function withBudget(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

export async function planPlaces(origin, needed) {
  const planned = {};
  try {
    const jobs = needed.map(async (need) => {
      try {
        const found = await overpassSearch(
          need.category,
          origin.lat,
          origin.lon,
          need.radius_m || 1200
        );
        return [need.key, found[0] || null];
      } catch (err) {
        console.error("place search", need.key, err.message);
        return [need.key, null];
      }
    });
    const pairs = await withBudget(Promise.all(jobs), PLAN_MS);
    for (const [key, value] of pairs) planned[key] = value;
  } catch (err) {
    console.error("planPlaces", err.message);
  }
  return planned;
}
