const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";

export class WeatherLocationError extends Error {
  constructor(code, candidates = []) {
    super(code);
    this.name = "WeatherLocationError";
    this.code = code;
    this.candidates = candidates;
  }
}

function normalize(value) {
  return String(value || "").toLocaleLowerCase("es-AR").normalize("NFD")
    .replace(/\p{Diacritic}/gu, "").replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim();
}

function displayLocation(item) {
  return {
    name: item.name,
    admin1: item.admin1 || "",
    country: item.country || "",
    latitude: item.latitude,
    longitude: item.longitude,
    timezone: item.timezone || "auto",
    id: item.id,
    featureCode: item.feature_code || "",
  };
}

function validCandidate(item) {
  return item && typeof item.name === "string"
    && Number.isFinite(item.latitude) && item.latitude >= -90 && item.latitude <= 90
    && Number.isFinite(item.longitude) && item.longitude >= -180 && item.longitude <= 180;
}

export async function geocodeLocation(name, { fetchImpl = fetch } = {}) {
  const query = typeof name === "string" ? name.trim() : "";
  if (query.length < 2 || query.length > 120) throw new WeatherLocationError("location_not_found");
  const parts = query.split(",").map((part) => part.trim()).filter(Boolean);
  const params = new URLSearchParams({ name: query, count: "10", language: "es", format: "json" });
  if (parts.slice(1).some((part) => normalize(part).split(" ").includes("argentina"))) {
    // Open-Meteo's countryCode filter prevents same-name locations abroad.
    params.set("countryCode", "AR");
  }
  const url = `${GEOCODING_URL}?${params}`;
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new WeatherLocationError("geocoding_unavailable");
  }
  if (!response.ok) throw new WeatherLocationError("geocoding_unavailable");
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new WeatherLocationError("geocoding_unavailable");
  }
  const results = Array.isArray(payload.results) ? payload.results.filter(validCandidate) : [];
  if (!results.length) throw new WeatherLocationError("location_not_found");

  let candidates = results;
  if (parts.length > 1) {
    const qualifier = normalize(parts.slice(1).join(" "));
    const filtered = candidates.filter((item) => {
      const areas = normalize([item.country, item.country_code, item.admin1, item.admin2, item.admin3].filter(Boolean).join(" "));
      return qualifier.split(" ").every((token) => areas.split(" ").includes(token));
    });
    if (filtered.length) candidates = filtered;
  }

  // Prefer populated localities over administrative regions with the same name.
  const settlements = candidates.filter((item) => /^(?:PPL|PPLC|PPLA|PPLA2|PPLA3|PPLX)/i.test(item.feature_code || ""));
  if (settlements.length) candidates = settlements;

  const normalizedName = normalize(parts[0]);
  const exact = candidates.filter((item) => normalize(item.name) === normalizedName);
  if (exact.length) candidates = exact;
  candidates = candidates.slice(0, 6);

  if (candidates.length > 1) {
    throw new WeatherLocationError("location_ambiguous", candidates.map(displayLocation));
  }
  return displayLocation(candidates[0]);
}

