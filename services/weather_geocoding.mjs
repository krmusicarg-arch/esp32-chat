const GEONAMES_SEARCH_URLS = [
  "https://secure.geonames.org/searchJSON",
  "https://api.geonames.org/searchJSON",
];

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
  const latitude = Number(item.lat);
  const longitude = Number(item.lng);
  return {
    name: item.name,
    admin1: item.adminName1 || "",
    province: item.adminName1 || "",
    country: item.countryName || "Argentina",
    countryCode: item.countryCode,
    latitude,
    longitude,
    timezone: item.timezone?.timeZoneId || "auto",
    id: item.geonameId,
    geonameId: item.geonameId,
    featureCode: item.fcode || "",
  };
}

function validResult(item) {
  const latitude = Number(item?.lat);
  const longitude = Number(item?.lng);
  return item && typeof item.name === "string" && item.name.trim().length > 0
    && item.countryCode === "AR"
    && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
    && Number.isInteger(Number(item.geonameId));
}

export async function resolveLocationArgentina(name, province = "", {
  fetchImpl = fetch,
  username = "",
} = {}) {
  const query = typeof name === "string" ? name.trim() : "";
  const provinceQuery = typeof province === "string" ? province.trim() : "";
  if (query.length < 2 || query.length > 120 || provinceQuery.length > 100) {
    throw new WeatherLocationError("location_not_found");
  }
  if (!username || typeof username !== "string") {
    throw new WeatherLocationError("geonames_not_configured");
  }

  const params = new URLSearchParams({
    name: query,
    country: "AR",
    lang: "es",
    maxRows: "1",
    username,
    type: "json",
  });
  let response = null;
  let lastConnectionCode = "";
  for (const [index, endpoint] of GEONAMES_SEARCH_URLS.entries()) {
    try {
      response = await fetchImpl(`${endpoint}?${params}`, { signal: AbortSignal.timeout(8000) });
      if (response.ok || (response.status < 500 && response.status !== 404)) break;
      console.warn(`[Weather] GeoNames HTTP error on endpoint ${index + 1} (${response.status}); trying fallback`);
    } catch (error) {
      const causeCode = error?.cause?.code;
      lastConnectionCode = typeof causeCode === "string" && /^[A-Z0-9_]+$/.test(causeCode)
        ? causeCode : error?.name || "Error";
      console.warn(`[Weather] GeoNames connection failed on endpoint ${index + 1} (${lastConnectionCode}); trying fallback`);
      response = null;
    }
  }
  if (!response) {
    console.error(`[Weather] GeoNames endpoints unavailable (${lastConnectionCode || "connection error"})`);
    throw new WeatherLocationError("geocoding_unavailable");
  }
  if (!response.ok) {
    console.error(`[Weather] GeoNames HTTP error (${response.status})`);
    throw new WeatherLocationError("geocoding_unavailable");
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    console.error("[Weather] GeoNames returned invalid JSON");
    throw new WeatherLocationError("geocoding_unavailable");
  }
  if (payload?.status) {
    const errorCode = Number(payload.status.value);
    console.error(`[Weather] GeoNames service error (${Number.isFinite(errorCode) ? errorCode : "unknown"})`);
    throw new WeatherLocationError(errorCode === 10 || errorCode === 11
      ? "geonames_auth_failed" : "geocoding_unavailable");
  }

  const matches = Array.isArray(payload.geonames) ? payload.geonames : [];
  if (!matches.length) throw new WeatherLocationError("location_not_found");
  const result = matches[0];
  if (!validResult(result) || (result.fcl && result.fcl !== "P")) {
    throw new WeatherLocationError("location_not_found");
  }

  const location = displayLocation(result);
  if (provinceQuery && normalize(location.province) !== normalize(provinceQuery)) {
    throw new WeatherLocationError("province_mismatch", [location]);
  }
  if (!provinceQuery && Number(payload.totalResultsCount) > 1 && result.fcode !== "PPLC") {
    throw new WeatherLocationError("location_ambiguous", [location]);
  }
  return location;
}

// Kept as an alias for existing callers; every lookup is still constrained to AR.
export async function geocodeLocation(name, { fetchImpl = fetch, username = "", province = "" } = {}) {
  return resolveLocationArgentina(name, province, { fetchImpl, username });
}
