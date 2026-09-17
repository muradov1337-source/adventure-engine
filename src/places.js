const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const QUERIES = {
  cafe: (lat, lon, r) => `
    [out:json][timeout:25];
    (
      nwr["amenity"="cafe"](around:${r},${lat},${lon});
      nwr["amenity"="coffee_shop"](around:${r},${lat},${lon});
      nwr["amenity"="fast_food"]["cuisine"~"coffee|tea",i](around:${r},${lat},${lon});
    );
    out center 12;
  `,
  bench: (lat, lon, r) => `
    [out:json][timeout:25];
    (
      node["amenity"="bench"](around:${r},${lat},${lon});
      node["leisure"="park"](around:${r},${lat},${lon});
    );
    out center 12;
  `,
  water: (lat, lon, r) => `
    [out:json][timeout:25];
    (
      nwr["amenity"="fountain"](around:${r},${lat},${lon});
      node["natural"="water"](around:${r},${lat},${lon});
      node["natural"="spring"](around:${r},${lat},${lon});
    );
    out center 12;
  `,
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
  const body = builder(lat, lon, radius);
  const origin = { lat, lon };

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "User-Agent": "adventure-engine/0.2",
        },
        body,
      });
      if (!res.ok) continue;
      const json = await res.json();
      const list = (json.elements || [])
        .map((el) => normalizeElement(el, origin, category))
        .filter(Boolean)
        .sort((a, b) => a.meters - b.meters);
      if (list.length) return list;
    } catch (err) {
      console.error("overpass fail", endpoint, err.message);
    }
  }
  return [];
}

async function nominatimSearch(query, lat, lon) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "5");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "adventure-engine/0.2" },
    });
    if (!res.ok) return [];
    const json = await res.json();
    const origin = { lat, lon };
    return (json || []).map((el) => {
      const plat = Number(el.lat);
      const plon = Number(el.lon);
      const meters = Math.round(distM(origin, { lat: plat, lon: plon }));
      return {
        name: el.display_name?.split(",")[0] || query,
        lat: plat,
        lon: plon,
        meters,
        minutes: walkMin(meters),
        maps: mapsPlaceLink(plat, plon, el.display_name),
        category: query,
        exact: true,
      };
    });
  } catch (err) {
    console.error("nominatim fail", err.message);
    return [];
  }
}

export function formatPlaceLine(place) {
  if (!place) return "";
  return `${place.name}. Приблизно ${place.minutes} хв пішки від старту.`;
}

export function fallbackMapsQuery(category) {
  if (category === "cafe") return "кафе";
  if (category === "bench") return "лавка OR парк";
  if (category === "water") return "фонтан OR озеро";
  return "місце";
}

export async function planPlaces(origin, needed) {
  const planned = {};
  let from = origin;

  for (const need of needed) {
    let found = await overpassSearch(need.category, from.lat, from.lon, need.radius_m);
    if (!found.length) {
      const q = need.category === "cafe" ? "cafe" : need.category === "bench" ? "park" : "fountain";
      found = await nominatimSearch(q, from.lat, from.lon);
    }
    const pick = found[0] || null;
    planned[need.key] = pick;
    if (pick) from = { lat: pick.lat, lon: pick.lon };
  }

  return planned;
}
