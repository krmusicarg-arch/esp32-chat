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

export async function geocodeCountryCode(name, { fetchImpl = fetch } = {}) {
  const query = typeof name === "string" ? name.trim() : "";
  if (query.length < 2 || query.length > 120) return "";
  const params = new URLSearchParams({ name: query, count: "100", language: "es", format: "json" });
  let response;
  try {
    response = await fetchImpl(`${GEOCODING_URL}?${params}`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return "";
    const payload = await response.json();
    const expected = normalize(query);
    const country = (Array.isArray(payload.results) ? payload.results : []).find((item) =>
      validCandidate(item) && /^PCLI$/i.test(item.feature_code || "")
      && normalize(item.name) === expected && /^[A-Z]{2}$/i.test(item.country_code || ""));
    return country?.country_code?.toUpperCase() || "";
  } catch {
    return "";
  }
}

export async function geocodeLocation(name, { fetchImpl = fetch } = {}) {
  const query = typeof name === "string" ? name.trim() : "";
  if (query.length < 2 || query.length > 120) throw new WeatherLocationError("location_not_found");
  const parts = query.split(",").map((part) => part.trim()).filter(Boolean);
  const params = new URLSearchParams({ name: query, count: "10", language: "es", format: "json" });
  const countryQualifier = parts[1];
  if (countryQualifier && /^[a-z]{2}$/i.test(countryQualifier)) params.set("countryCode", countryQualifier.toUpperCase());
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
  // Open-Meteo applies the qualifier in the query itself. Do not re-filter
  // against localized display names here: "United States" may be returned as
  // "Estados Unidos" when language=es.

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

