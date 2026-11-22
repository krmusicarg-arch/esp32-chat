import assert from "node:assert/strict";
import test from "node:test";
import { createMobileSessionToken } from "./lib/mobile_auth.mjs";
import { createWeatherHandler } from "./lib/weather_controller.mjs";
import { createWeatherAssistant, WEATHER_INTENTS } from "./services/weather_assistant.mjs";
import { detectWeatherIntent } from "./services/weather_intent.mjs";
import { geocodeLocation, WeatherLocationError } from "./services/weather_geocoding.mjs";
import { createWeatherService } from "./services/weather_service.mjs";

const TEST_DATE = new Date("2026-11-22T12:00:00.000Z");
const MOBILE_SECRET = "m".repeat(64);
const MOBILE_SPEAKER = "123e4567-e89b-42d3-a456-426614174000";
const CONFIG = {
  mobileSessionSecret: MOBILE_SECRET,
  deviceToken: "test-weather-device-token-012345",
  mobileOrigins: ["https://robert.example"],
  weatherDefaultLocation: "Buenos Aires, Argentina",
};

function addDays(date, offset) {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + offset);
  return next.toISOString().slice(0, 10);
}

function forecastPayload() {
  const days = Array.from({ length: 7 }, (_, index) => addDays("2026-11-22", index));
  const hours = days.flatMap((date) => Array.from({ length: 24 }, (_, hour) => `${date}T${String(hour).padStart(2, "0")}:00`));
  return {
    timezone: "America/Argentina/Buenos_Aires",
    utc_offset_seconds: -10800,
    current: {
      time: "2026-11-22T09:00",
      temperature_2m: 24.3,
      relative_humidity_2m: 48,
      apparent_temperature: 25.1,
      precipitation: 0,
      weather_code: 2,
      wind_speed_10m: 13.2,
      wind_direction_10m: 90,
    },
    daily: {
      time: days,
      weather_code: [2, 61, 3, 1, 0, 80, 2],
      temperature_2m_max: [27, 25, 23, 28, 30, 24, 26],
      temperature_2m_min: [16, 17, 15, 18, 19, 16, 17],
      precipitation_probability_max: [10, 75, 20, 5, 0, 60, 15],
      precipitation_sum: [0, 4.2, 0, 0, 0, 2.1, 0],
      wind_speed_10m_max: [20, 22, 18, 15, 14, 21, 16],
      sunrise: days.map((day) => `${day}T05:40`),
      sunset: days.map((day) => `${day}T19:45`),
    },
    hourly: {
      time: hours,
      temperature_2m: hours.map((_, index) => 17 + (index % 12)),
      precipitation_probability: hours.map((_, index) => index % 24 === 15 ? 70 : 5),
      precipitation: hours.map(() => 0),
      weather_code: hours.map(() => 2),
      wind_speed_10m: hours.map(() => 12),
    },
  };
}

function place(name, admin1 = "Buenos Aires", country = "Argentina", id = 1) {
  return {
    id,
    name,
    admin1,
    country,
    country_code: "AR",
    latitude: -34.6 + id / 10000,
    longitude: -58.4 + id / 10000,
    timezone: "America/Argentina/Buenos_Aires",
    feature_code: "PPLA",
    population: 100000,
  };
}

function openMeteoFetch({ locations = () => [place("Buenos Aires")], failForecast = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://geocoding-api.open-meteo.com/")) {
      return new Response(JSON.stringify({ results: locations(new URL(url).searchParams.get("name")) }));
    }
    if (String(url).startsWith("https://api.open-meteo.com/")) {
      if (failForecast) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify(forecastPayload()));
    }
    throw new Error(`Unexpected external URL: ${url}`);
  };
  return { fetchImpl, calls };
}

function fakeHttpResponse() {
  return {
    headers: {},
    writeHead(status, headers = {}) { this.statusCode = status; Object.assign(this.headers, headers); },
    end(value = "") { this.body = value; },
  };
}

test("detects current, today, tomorrow, week, weekend, date and hourly periods", () => {
  assert.equal(detectWeatherIntent("¿Cómo está el clima ahora?").period, WEATHER_INTENTS.CURRENT);
  assert.equal(detectWeatherIntent("¿Va a llover hoy?").period, WEATHER_INTENTS.TODAY);
  assert.equal(detectWeatherIntent("¿Va a llover mañana?").period, WEATHER_INTENTS.TOMORROW);
  assert.equal(detectWeatherIntent("¿Cómo va a estar esta semana?").period, WEATHER_INTENTS.WEEK);
  assert.equal(detectWeatherIntent("¿Qué tiempo tendremos el fin de semana?").period, WEATHER_INTENTS.WEEKEND);
  assert.equal(detectWeatherIntent("¿Qué temperatura habrá el 25 de noviembre?").date, "2026-11-25");
  assert.equal(detectWeatherIntent("¿Qué temperatura tendremos mañana a las 15 hs?").period, WEATHER_INTENTS.HOURLY);
  assert.equal(detectWeatherIntent("¿Cuánto tiempo lleva la película?"), null);
});

test("geocoding resolves Buenos Aires and Villa Carlos Paz with location metadata", async () => {
  const { fetchImpl } = openMeteoFetch({
    locations: (query) => [query.includes("Carlos Paz")
      ? place("Villa Carlos Paz", "Córdoba", "Argentina", 2)
      : place("Buenos Aires")],
  });
  const buenosAires = await geocodeLocation("Buenos Aires, Argentina", { fetchImpl });
  const villaCarlosPaz = await geocodeLocation("Villa Carlos Paz", { fetchImpl });
  assert.equal(buenosAires.name, "Buenos Aires");
  assert.equal(buenosAires.country, "Argentina");
  assert.equal(villaCarlosPaz.name, "Villa Carlos Paz");
  assert.equal(villaCarlosPaz.admin1, "Córdoba");
});

test("asks for clarification when a place name has multiple exact populated matches", async () => {
  const { fetchImpl } = openMeteoFetch({
    locations: () => [place("Springfield", "Illinois", "United States", 3), place("Springfield", "Massachusetts", "United States", 4)],
  });
  await assert.rejects(() => geocodeLocation("Springfield", { fetchImpl }), (error) => {
    assert.ok(error instanceof WeatherLocationError);
    assert.equal(error.code, "location_ambiguous");
    assert.equal(error.candidates.length, 2);
    return true;
  });
});

test("weather requests use the requested fields, units, timezone and seven-day range; cache lasts 30 minutes", async () => {
  let now = TEST_DATE.getTime();
  const calls = [];
  const service = createWeatherService({
    clock: () => now,
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      return new Response(JSON.stringify(forecastPayload()));
    },
  });
  await service.getForecast(-34.6, -58.4);
  await service.getForecast(-34.6, -58.4);
  assert.equal(calls.length, 1);
  const params = calls[0].searchParams;
  assert.equal(params.get("forecast_days"), "7");
  assert.equal(params.get("timezone"), "auto");
  assert.equal(params.get("temperature_unit"), "celsius");
  assert.equal(params.get("wind_speed_unit"), "kmh");
  assert.equal(params.get("precipitation_unit"), "mm");
  assert.match(params.get("current"), /temperature_2m.*relative_humidity_2m.*weather_code/);
  assert.match(params.get("daily"), /temperature_2m_max.*sunrise.*sunset/);
  assert.match(params.get("hourly"), /precipitation_probability.*weather_code/);
  now += 30 * 60 * 1000 + 1;
  await service.getForecast(-34.6, -58.4);
  assert.equal(calls.length, 2);
});

test("returns current conditions from authorized coordinates without geocoding", async () => {
  const { fetchImpl, calls } = openMeteoFetch();
  const answerWeather = createWeatherAssistant({ fetchImpl, clock: () => TEST_DATE });
  const result = await answerWeather({
    question: "¿Cómo está el clima ahora?",
    currentLocation: { latitude: -34.6, longitude: -58.4 },
  });
  assert.equal(result.weather.period, WEATHER_INTENTS.CURRENT);
  assert.equal(result.weather.location.name, "Tu ubicación actual");
  assert.equal(result.weather.current.temperature, 24.3);
  assert.equal(result.weather.current.relativeHumidity, 48);
  assert.match(result.answer, /24°/);
  assert.equal(calls.filter((url) => url.includes("geocoding-api")).length, 0);
});

test("returns today, tomorrow and seven-day forecasts with exact API values", async () => {
  const { fetchImpl } = openMeteoFetch();
  const answerWeather = createWeatherAssistant({ fetchImpl, clock: () => TEST_DATE });
  const today = await answerWeather({ question: "¿Cómo va a estar hoy en Buenos Aires, Argentina?" });
  const tomorrow = await answerWeather({ question: "¿Va a llover mañana en Buenos Aires, Argentina?" });
  const week = await answerWeather({ question: "¿Cómo va a estar los próximos 7 días en Buenos Aires, Argentina?" });
  assert.equal(today.weather.period, WEATHER_INTENTS.TODAY);
  assert.equal(today.weather.days.length, 1);
  assert.equal(today.weather.days[0].temperatureMax, 27);
  assert.equal(tomorrow.weather.period, WEATHER_INTENTS.TOMORROW);
  assert.equal(tomorrow.weather.days[0].precipitationProbability, 75);
  assert.equal(week.weather.days.length, 7);
  assert.match(week.answer, /75%/);
});

test("returns an hourly forecast for the requested local hour", async () => {
  const { fetchImpl } = openMeteoFetch();
  const answerWeather = createWeatherAssistant({ fetchImpl, clock: () => TEST_DATE });
  const result = await answerWeather({ question: "¿Qué temperatura tendremos mañana a las 15 hs en Buenos Aires, Argentina?" });
  assert.equal(result.weather.period, WEATHER_INTENTS.HOURLY);
  assert.equal(result.weather.hours.length, 1);
  assert.equal(result.weather.hours[0].time, "2026-11-23T15:00");
  assert.equal(result.weather.hours[0].precipitationProbability, 70);
});

test("returns a forecast for Villa Carlos Paz and asks before choosing duplicate localities", async () => {
  const villaFetch = openMeteoFetch({ locations: () => [place("Villa Carlos Paz", "Córdoba", "Argentina", 2)] });
  const villaAssistant = createWeatherAssistant({ fetchImpl: villaFetch.fetchImpl, clock: () => TEST_DATE });
  const villa = await villaAssistant({ question: "¿Va a llover en Villa Carlos Paz?" });
  assert.equal(villa.weather.location.name, "Villa Carlos Paz");
  assert.equal(villa.weather.location.admin1, "Córdoba");

  const ambiguousFetch = openMeteoFetch({
    locations: () => [place("Springfield", "Illinois", "United States", 3), place("Springfield", "Massachusetts", "United States", 4)],
  });
  const ambiguousAssistant = createWeatherAssistant({ fetchImpl: ambiguousFetch.fetchImpl, clock: () => TEST_DATE });
  const ambiguous = await ambiguousAssistant({ question: "¿Cómo está el clima en Springfield?" });
  assert.equal(ambiguous.status, "location_ambiguous");
  assert.equal(ambiguous.weather.needsClarification, true);
});

test("does not invent a result when a locality is not found", async () => {
  const { fetchImpl, calls } = openMeteoFetch({ locations: () => [] });
  const answerWeather = createWeatherAssistant({ fetchImpl, clock: () => TEST_DATE });
  const result = await answerWeather({ question: "¿Va a llover mañana en Localidad Inexistente?" });
  assert.equal(result.status, "location_not_found");
  assert.match(result.answer, /No encontré esa localidad/);
  assert.equal(calls.filter((url) => url.includes("api.open-meteo.com/v1/forecast")).length, 0);
});

test("uses the configured default location when browser geolocation is denied or unavailable", async () => {
  const { fetchImpl, calls } = openMeteoFetch();
  const answerWeather = createWeatherAssistant({ fetchImpl, clock: () => TEST_DATE, defaultLocation: "Buenos Aires, Argentina" });
  const result = await answerWeather({ question: "¿Va a llover mañana?", currentLocation: null });
  assert.equal(result.weather.usedDefaultLocation, true);
  const geocodingUrl = new URL(calls.find((url) => url.includes("geocoding-api")));
  assert.equal(geocodingUrl.searchParams.get("name"), "Buenos Aires, Argentina");
  assert.equal(result.weather.days[0].date, "2026-11-23");
});

test("reports an Open-Meteo failure without falling back to stale data", async () => {
  const { fetchImpl } = openMeteoFetch({ failForecast: true });
  const answerWeather = createWeatherAssistant({ fetchImpl, clock: () => TEST_DATE });
  const result = await answerWeather({ question: "¿Cómo está el clima ahora?", currentLocation: { latitude: -34.6, longitude: -58.4 } });
  assert.equal(result.status, "weather_unavailable");
  assert.equal(result.weather, null);
  assert.match(result.answer, /No pude obtener el pronóstico/);
});

test("POST /api/weather authenticates, returns structured data and does not require chat or memory services", async () => {
  const { fetchImpl } = openMeteoFetch();
  const handler = createWeatherHandler({ config: CONFIG, fetchImpl, clock: () => TEST_DATE });
  const token = createMobileSessionToken(MOBILE_SECRET, MOBILE_SPEAKER, TEST_DATE);
  const req = {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, origin: "https://robert.example" },
    body: { question: "¿Cómo está el clima ahora?", current_location: { latitude: -34.6, longitude: -58.4 } },
  };
  const res = fakeHttpResponse();
  await handler(req, res);
  const payload = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.searched_web, false);
  assert.equal(payload.weather.current.temperature, 24.3);
  assert.equal(res.headers["access-control-allow-origin"], "https://robert.example");

  const unauthorized = fakeHttpResponse();
  await handler({ ...req, headers: {}, body: req.body }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);
});
