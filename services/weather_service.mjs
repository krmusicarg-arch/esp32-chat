const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const CACHE_TTL_MS = 30 * 60 * 1000;
const CURRENT_FIELDS = [
  "temperature_2m", "relative_humidity_2m", "apparent_temperature",
  "precipitation", "weather_code", "wind_speed_10m", "wind_direction_10m",
];
const DAILY_FIELDS = [
  "weather_code", "temperature_2m_max", "temperature_2m_min",
  "precipitation_probability_max", "precipitation_sum", "wind_speed_10m_max",
  "sunrise", "sunset",
];
const HOURLY_FIELDS = [
  "temperature_2m", "precipitation_probability", "precipitation",
  "weather_code", "wind_speed_10m",
];

export class WeatherApiError extends Error {
  constructor(code = "weather_unavailable") {
    super(code);
    this.name = "WeatherApiError";
    this.code = code;
  }
}

function pickSeries(source, fields) {
  const output = {};
  for (const field of fields) output[field] = source?.[field] ?? null;
  return output;
}

function validTimeSeries(series, field, minimumLength = 1) {
  return Array.isArray(series?.time) && series.time.length >= minimumLength
    && fieldsExist(series, field);
}

function validCurrent(current) {
  return current && typeof current.time === "string"
    && CURRENT_FIELDS.every((field) => Object.hasOwn(current, field));
}

function fieldsExist(series, fields) {
  return fields.every((field) => Array.isArray(series[field]) && series[field].length === series.time.length);
}

function makeForecast(payload, fetchedAt) {
  if (!payload || typeof payload !== "object"
      || !validCurrent(payload.current)
      || !validTimeSeries(payload.daily, DAILY_FIELDS, 1)
      || !validTimeSeries(payload.hourly, HOURLY_FIELDS, 1)) {
    throw new WeatherApiError("invalid_weather_response");
  }
  const current = { time: payload.current.time, ...pickSeries(payload.current, CURRENT_FIELDS) };
  const days = payload.daily.time.map((date, index) => ({
    date,
    ...Object.fromEntries(DAILY_FIELDS.map((field) => [field, payload.daily[field][index] ?? null])),
  }));
  const hours = payload.hourly.time.map((time, index) => ({
    time,
    ...Object.fromEntries(HOURLY_FIELDS.map((field) => [field, payload.hourly[field][index] ?? null])),
  }));
  return {
    timezone: payload.timezone || "UTC",
    utcOffsetSeconds: Number.isFinite(payload.utc_offset_seconds) ? payload.utc_offset_seconds : 0,
    current,
    days,
    hours,
    fetchedAt: new Date(fetchedAt).toISOString(),
  };
}

export function createWeatherService({ fetchImpl = fetch, clock = () => Date.now(), cacheTtlMs = CACHE_TTL_MS } = {}) {
  const cache = new Map();
  const inFlight = new Map();

  async function getForecast(latitude, longitude) {
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new WeatherApiError("invalid_coordinates");
    }
    const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const now = Number(clock());
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;
    if (cached) cache.delete(cacheKey);
    if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

    const pending = (async () => {
      const params = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: CURRENT_FIELDS.join(","),
        daily: DAILY_FIELDS.join(","),
        hourly: HOURLY_FIELDS.join(","),
        temperature_unit: "celsius",
        wind_speed_unit: "kmh",
        precipitation_unit: "mm",
        timezone: "auto",
        forecast_days: "7",
      });
      let response;
      try {
        response = await fetchImpl(`${FORECAST_URL}?${params}`, { signal: AbortSignal.timeout(10000) });
      } catch {
        throw new WeatherApiError("weather_unavailable");
      }
      if (!response.ok) throw new WeatherApiError("weather_unavailable");
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new WeatherApiError("invalid_weather_response");
      }
      const fetchedAt = Number(clock());
      const forecast = makeForecast(payload, fetchedAt);
      cache.set(cacheKey, { value: forecast, expiresAt: fetchedAt + cacheTtlMs });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return forecast;
    })();
    inFlight.set(cacheKey, pending);
    try {
      return await pending;
    } finally {
      if (inFlight.get(cacheKey) === pending) inFlight.delete(cacheKey);
    }
  }

  return { getForecast, clearCache: () => cache.clear() };
}

