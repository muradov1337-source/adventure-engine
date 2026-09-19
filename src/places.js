const FETCH_MS = 4000;
const PLAN_MS = 7000;

const CATEGORIES = {
  cafe: "catering.cafe,catering.cafe.coffee,catering.cafe.coffee_shop",
  park: "leisure.park,leisure.picnic,activity.community_center",
  stop: "public_transport,public_transport.bus,public_transport.tram",
  bench: "leisure.park,leisure.picnic",
  water:
    "natural.water,natural.water.sea,natural.water.river_system,natural.water.spring,beach,leisure.swimming_pool",
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

async function fetchJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_MS),
    headers: { "User-Agent": "adventure-engine/0.5" },
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

function looksClosed(props) {
  const hours = String(props.opening_hours || props.openingHours || "").toLowerCase();
  if (!hours) return false;
  if (hours.includes("24/7")) return false;
  return false;
}

async function geoapifySearch(category, lat, lon, radius) {
  const key = process.env.GEOAPIFY_KEY;
  if (!key) return [];
  const cats = CATEGORIES[category] || category;
  const url = new URL("https://api.geoapify.com/v2/places");
  url.searchParams.set("categories", cats);
  url.searchParams.set("filter", `circle:${lon},${lat},${radius}`);
  url.searchParams.set("bias", `proximity:${lon},${lat}`);
  url.searchParams.set("limit", "8");
  url.searchParams.set("lang", "uk");
  url.searchParams.set("apiKey", key);

  const json = await fetchJson(url);
  const origin = { lat, lon };
  const fallbackName =
    category === "cafe"
      ? "кав’ярня поруч"
      : category === "park"
        ? "парк або сквер поруч"
        : category === "stop"
          ? "зупинка поруч"
          : "місце поруч";

  return (json.features || [])
    .map((f) => {
      const [plon, plat] = f.geometry?.coordinates || [];
      const p = f.properties || {};
      if (!plat || !plon) return null;
      if (category === "cafe" && looksClosed(p)) return null;
      const name = p.name || p.address_line1 || null;
      const meters = Math.round(p.distance || distM(origin, { lat: plat, lon: plon }));
      return {
        name: name || fallbackName,
        lat: plat,
        lon: plon,
        meters,
        minutes: walkMin(meters),
        maps: mapsPlaceLink(plat, plon, name),
        category,
        exact: Boolean(p.name),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.meters - b.meters);
}

export function formatPlaceLine(place) {
  if (!place) return "";
  return `${place.name}. Приблизно ${place.minutes} хв пішки звідси.`;
}

export function fallbackMapsQuery(category) {
  if (category === "cafe") return "кафе";
  if (category === "park" || category === "bench") return "парк";
  if (category === "stop") return "зупинка транспорту";
  if (category === "water") return "озеро OR фонтан OR річка";
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
  if (!needed?.length) return planned;
  try {
    const jobs = needed.map(async (need) => {
      try {
        const found = await geoapifySearch(
          need.category,
          origin.lat,
          origin.lon,
          need.radius_m || 1500
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
