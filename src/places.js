const OVERPASS = "https://overpass-api.de/api/interpreter";

const QUERIES = {
  cafe: (lat, lon, r) => `
    [out:json][timeout:20];
    (
      node["amenity"="cafe"](around:${r},${lat},${lon});
      node["amenity"="coffee_shop"](around:${r},${lat},${lon});
    );
    out body 8;
  `,
  bench: (lat, lon, r) => `
    [out:json][timeout:20];
    (
      node["amenity"="bench"](around:${r},${lat},${lon});
    );
    out body 8;
  `,
  water: (lat, lon, r) => `
    [out:json][timeout:20];
    (
      node["amenity"="fountain"](around:${r},${lat},${lon});
      node["natural"="water"](around:${r},${lat},${lon});
      node["natural"="spring"](around:${r},${lat},${lon});
    );
    out body 8;
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

function mapsLink(lat, lon, name) {
  const q = encodeURIComponent(name || `${lat},${lon}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}&query_lat=${lat}&query_lon=${lon}`;
}

async function search(category, lat, lon, radius) {
  const builder = QUERIES[category];
  if (!builder) return [];
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: builder(lat, lon, radius),
  });
  if (!res.ok) return [];
  const json = await res.json();
  const origin = { lat, lon };
  return (json.elements || [])
    .filter((el) => el.lat && el.lon)
    .map((el) => {
      const name = el.tags?.name || el.tags?.["name:uk"] || null;
      const meters = Math.round(distM(origin, { lat: el.lat, lon: el.lon }));
      return {
        name: name || defaultName(category),
        lat: el.lat,
        lon: el.lon,
        meters,
        minutes: walkMin(meters),
        maps: mapsLink(el.lat, el.lon, name),
        category,
      };
    })
    .sort((a, b) => a.meters - b.meters);
}

function defaultName(category) {
  if (category === "cafe") return "кав’ярня поруч";
  if (category === "bench") return "лавка поруч";
  if (category === "water") return "вода поруч";
  return "місце поруч";
}

export function formatPlaceLine(place) {
  if (!place) return "";
  return `${place.name}. Приблизно ${place.minutes} хв пішки від старту.`;
}

export async function planPlaces(origin, needed) {
  const planned = {};
  let from = origin;

  for (const need of needed) {
    const found = await search(need.category, from.lat, from.lon, need.radius_m);
    const pick = found[0] || null;
    planned[need.key] = pick;
    if (pick) from = { lat: pick.lat, lon: pick.lon };
  }

  return planned;
}
