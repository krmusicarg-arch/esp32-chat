import { detectWeatherIntent, WEATHER_INTENTS } from "./weather_intent.mjs";
import { geocodeLocation, WeatherLocationError } from "./weather_geocoding.mjs";
import { createWeatherService, WeatherApiError } from "./weather_service.mjs";
import { describeWeatherCode } from "./weather_codes.mjs";

const ARGENTINE_PROVINCES = new Set([
  "Buenos Aires", "Catamarca", "Chaco", "Chubut", "Córdoba", "Corrientes", "Entre Ríos", "Formosa",
  "Jujuy", "La Pampa", "La Rioja", "Mendoza", "Misiones", "Neuquén", "Río Negro", "Salta",
  "San Juan", "San Luis", "Santa Cruz", "Santa Fe", "Santiago del Estero", "Tierra del Fuego", "Tucumán",
].map((province) => province.toLocaleLowerCase("es-AR").normalize("NFD").replace(/\p{Diacritic}/gu, "")));

function normalizeProvince(value) {
  const normalized = String(value || "").toLocaleLowerCase("es-AR").normalize("NFD")
    .replace(/\p{Diacritic}/gu, "").replace(/^provincia\s+(?:de\s+)?/i, "").trim();
  return ARGENTINE_PROVINCES.has(normalized) ? normalized : "";
}

function normalizeText(value) {
  return String(value || "").toLocaleLowerCase("es-AR").normalize("NFD").replace(/\p{Diacritic}/gu, "").trim();
}

function condition(code) {
  const { description, icon } = describeWeatherCode(code);
  return [description, icon];
}

function formatTemperature(value) {
  return Number.isFinite(value) ? `${Math.round(value)}°` : "";
}

function dateLabel(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat("es-AR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(parsed);
}

function formatLocation(place) {
  if (place.source === "device") return { name: "Tu ubicación actual", admin1: "", country: "" };
  return {
    name: place.name,
    city: place.name,
    admin1: place.admin1 || "",
    province: place.admin1 || "",
    country: place.country || "",
    countryCode: place.countryCode || "AR",
    latitude: place.latitude,
    longitude: place.longitude,
    geonameId: place.geonameId || place.id,
  };
}

function locationLabel(location) {
  return [location.name, location.admin1, location.country]
    .filter(Boolean).filter((part, index, all) => all.indexOf(part) === index).join(", ");
}

function selectDays(forecast, intent) {
  const { period } = intent;
  if ([WEATHER_INTENTS.CURRENT, WEATHER_INTENTS.TODAY].includes(period)) return [forecast.days[0]].filter(Boolean);
  if (period === WEATHER_INTENTS.TOMORROW) return [forecast.days[1]].filter(Boolean);
  if (period === WEATHER_INTENTS.SPECIFIC_DATE) {
    const target = intent.date || forecast.days[intent.dayOffset || 0]?.date;
    return forecast.days.filter((day) => day.date === target);
  }
  if (period === WEATHER_INTENTS.WEEKEND) {
    return forecast.days.filter((day) => {
      const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
      return weekday === 0 || weekday === 6;
    });
  }
  if (period === WEATHER_INTENTS.WEEK) {
    const sundayIndex = forecast.days.findIndex((day) => new Date(`${day.date}T12:00:00Z`).getUTCDay() === 0);
    return forecast.days.slice(0, sundayIndex < 0 ? forecast.days.length : sundayIndex + 1);
  }
  if (period === WEATHER_INTENTS.HOURLY) {
    const date = intent.date || forecast.days[intent.dayOffset || 0]?.date || forecast.days[0]?.date;
    const dayHours = forecast.hours.filter((hour) => hour.time.startsWith(`${date}T`));
    if (intent.hour !== null) {
      return dayHours.filter((hour) => Number(hour.time.slice(11, 13)) === intent.hour
        && (intent.minute === null || Number(hour.time.slice(14, 16)) === intent.minute));
    }
    if (intent.timeFrame) {
      return dayHours.filter((hour) => {
        const h = Number(hour.time.slice(11, 13));
        return intent.timeFrame === "morning" ? h >= 5 && h < 12
          : intent.timeFrame === "afternoon" ? h >= 12 && h < 19 : h >= 19 || h < 5;
      });
    }
    const currentTime = forecast.current.time;
    const start = date === forecast.days[0]?.date
      ? dayHours.findIndex((hour) => hour.time >= currentTime)
      : 0;
    return dayHours.slice(Math.max(start, 0), Math.max(start, 0) + 6);
  }
  return forecast.days;
}

function dayForCard(day) {
  const [description, icon] = condition(day.weather_code);
  return {
    date: day.date,
    label: dateLabel(day.date),
    weatherCode: day.weather_code,
    description,
    icon,
    temperatureMin: day.temperature_2m_min,
    temperatureMax: day.temperature_2m_max,
    precipitationProbability: day.precipitation_probability_max,
    precipitation: day.precipitation_sum,
    windSpeedMax: day.wind_speed_10m_max,
    sunrise: day.sunrise,
    sunset: day.sunset,
  };
}

function hourForCard(hour) {
  const [description, icon] = condition(hour.weather_code);
  return {
    time: hour.time,
    weatherCode: hour.weather_code,
    description,
    icon,
    temperature: hour.temperature_2m,
    precipitationProbability: hour.precipitation_probability,
    precipitation: hour.precipitation,
    windSpeed: hour.wind_speed_10m,
  };
}

function currentForCard(current) {
  const [description, icon] = condition(current.weather_code);
  return {
    time: current.time,
    weatherCode: current.weather_code,
    description,
    icon,
    temperature: current.temperature_2m,
    apparentTemperature: current.apparent_temperature,
    relativeHumidity: current.relative_humidity_2m,
    precipitation: current.precipitation,
    windSpeed: current.wind_speed_10m,
    windDirection: current.wind_direction_10m,
  };
}

function probabilityText(probability) {
  if (!Number.isFinite(probability)) return "";
  const level = probability < 20 ? "baja" : probability < 50 ? "moderada" : "alta";
  return `La probabilidad de lluvia es ${level} (${Math.round(probability)}%).`;
}

function buildAnswer(weather) {
  const where = locationLabel(weather.location);
  if (weather.current && weather.period === WEATHER_INTENTS.CURRENT) {
    const current = weather.current;
    const parts = [`Ahora en ${where}`];
    if (Number.isFinite(current.temperature)) parts.push(`${formatTemperature(current.temperature)}.`);
    if (Number.isFinite(current.apparentTemperature)) parts.push(`Sensación térmica: ${formatTemperature(current.apparentTemperature)}.`);
    if (current.description) parts.push(`${current.description}.`);
    const today = weather.days?.[0];
    if (Number.isFinite(today?.temperatureMin) && Number.isFinite(today?.temperatureMax)) {
      parts.push(`Mínima ${formatTemperature(today.temperatureMin)} y máxima ${formatTemperature(today.temperatureMax)}.`);
    }
    if (Number.isFinite(current.relativeHumidity)) parts.push(`Humedad ${Math.round(current.relativeHumidity)}%.`);
    if (Number.isFinite(current.precipitation)) parts.push(`Precipitación actual: ${current.precipitation} mm.`);
    if (Number.isFinite(current.windSpeed)) parts.push(`Viento: ${Math.round(current.windSpeed)} km/h.`);
    return parts.join(" ");
  }
  if (weather.period === WEATHER_INTENTS.HOURLY) {
    if (!weather.hours.length) return `No encontré datos horarios para ese momento en ${where}.`;
    const entries = weather.hours.slice(0, 4).map((hour) => {
      const time = hour.time.slice(11, 16);
      const temp = Number.isFinite(hour.temperature) ? `${formatTemperature(hour.temperature)}` : "temperatura no disponible";
      const rain = Number.isFinite(hour.precipitationProbability) ? `, lluvia ${Math.round(hour.precipitationProbability)}%` : "";
      return `${time}: ${temp}${rain}`;
    });
    return `Pronóstico horario en ${where}: ${entries.join("; ")}.`;
  }
  if (!weather.days.length) return `No tengo datos del pronóstico para ese período en ${where}.`;
  if (weather.days.length === 1) {
    const day = weather.days[0];
    const label = weather.periodLabel;
    const parts = [`${label} en ${where}`];
    if (Number.isFinite(day.temperatureMax)) parts.push(`máxima de ${formatTemperature(day.temperatureMax)}`);
    if (Number.isFinite(day.temperatureMin)) parts.push(`mínima de ${formatTemperature(day.temperatureMin)}`);
    if (day.description) parts.push(day.description.toLocaleLowerCase("es-AR"));
    if (Number.isFinite(day.precipitationProbabilityMax)) parts.push(`probabilidad de lluvia ${Math.round(day.precipitationProbabilityMax)}%`);
    return `${parts.join(", ")}.`;
  }
  const lines = weather.days.map((day) => {
    const parts = [dateLabel(day.date)];
    if (Number.isFinite(day.temperatureMin) && Number.isFinite(day.temperatureMax)) {
      parts.push(`${formatTemperature(day.temperatureMin)} a ${formatTemperature(day.temperatureMax)}`);
    }
    if (Number.isFinite(day.precipitationProbability)) parts.push(`lluvia ${Math.round(day.precipitationProbability)}%`);
    return parts.join(": ");
  });
  const rainyDays = weather.days.filter((day) => Number.isFinite(day.precipitationProbability))
    .sort((a, b) => b.precipitationProbability - a.precipitationProbability).slice(0, 2);
  const rainSummary = rainyDays.length
    ? ` Mayor posibilidad de lluvia: ${rainyDays.map((day) => `${dateLabel(day.date)} (${Math.round(day.precipitationProbability)}%)`).join(" y ")}.`
    : "";
  const firstDay = weather.days[0];
  const lastDay = weather.days[weather.days.length - 1];
  const trend = Number.isFinite(firstDay.temperatureMax) && Number.isFinite(lastDay.temperatureMax)
    ? ` Tendencia de las máximas: de ${formatTemperature(firstDay.temperatureMax)} el ${dateLabel(firstDay.date)} a ${formatTemperature(lastDay.temperatureMax)} el ${dateLabel(lastDay.date)}.`
    : "";
  return `Pronóstico para ${where}: ${lines.join("; ")}.${rainSummary}${trend}`;
}

function periodLabel(period, dayOffset) {
  if (period === WEATHER_INTENTS.TODAY) return "Hoy";
  if (period === WEATHER_INTENTS.TOMORROW) return "Mañana";
  if (period === WEATHER_INTENTS.WEEKEND) return "Este fin de semana";
  if (period === WEATHER_INTENTS.WEEK) return "Esta semana";
  if (period === WEATHER_INTENTS.SEVEN_DAYS) return "Los próximos siete días";
  if (period === WEATHER_INTENTS.SPECIFIC_DATE) return "Para la fecha consultada";
  if (period === WEATHER_INTENTS.HOURLY) return dayOffset === 1 ? "Mañana" : "Hoy";
  return "Ahora";
}

function clarifyLocation(question, candidates) {
  const choices = candidates.map((candidate) => locationLabel(candidate));
  return {
    status: "location_ambiguous",
    answer: choices.length === 1
      ? `Encontré varias coincidencias. La primera es ${choices[0]}. ¿De qué provincia es la localidad que querés consultar?`
      : `Encontré varias localidades para esa búsqueda: ${choices.join("; ")}. ¿Cuál querés consultar?`,
    weather: {
      type: "weather_response",
      intent: "WEATHER_OTHER_LOCATION",
      needsClarification: true,
      query: question,
      candidates: candidates.map(({ name, admin1, country }) => ({ name, admin1, country })),
      source: "GeoNames",
    },
  };
}

export function createWeatherAssistant({
  fetchImpl = fetch,
  clock = () => new Date(),
  weatherService = createWeatherService({ fetchImpl, clock: () => clock().getTime() }),
  defaultLocation = "Buenos Aires, Argentina",
  geonamesUsername = "",
  geonamesApiUrl = "",
} = {}) {
  const locationCache = new Map();
  async function resolvePlace(query) {
    const key = query.toLocaleLowerCase("es-AR").normalize("NFD").replace(/\p{Diacritic}/gu, "").trim();
    const now = clock().getTime();
    const cached = locationCache.get(key);
    if (cached && cached.expiresAt > now) return { ...cached.place };
    if (cached) locationCache.delete(key);
    const parts = query.split(",").map((part) => part.trim()).filter(Boolean);
    const qualifiers = parts.slice(1).filter(Boolean);
    const requestedProvince = qualifiers.find((part) => normalizeProvince(part)) || "";
    const providedCountry = qualifiers.find((part) => !normalizeProvince(part));
    if (providedCountry && normalizeText(providedCountry) !== "argentina") {
      throw new WeatherLocationError("country_not_supported");
    }
    const place = await geocodeLocation(parts[0].replace(/^\s*(?:(?:la|el)\s+)?(?:ciudad|localidad)\s+de\s+/i, ""), {
      fetchImpl, username: geonamesUsername, province: requestedProvince, apiUrl: geonamesApiUrl,
    });
    locationCache.set(key, { place, expiresAt: now + 30 * 60 * 1000 });
    if (locationCache.size > 250) locationCache.delete(locationCache.keys().next().value);
    return { ...place };
  }

  return async function answerWeatherQuestion({ question }) {
    const intent = detectWeatherIntent(question, clock());
    if (!intent) return null;
    try {
      const requestedLocations = intent.locations || [];
      if (!requestedLocations.length && /\bdonde hace mas calor\b/.test(question.toLocaleLowerCase("es-AR").normalize("NFD").replace(/\p{Diacritic}/gu, ""))) {
        return { status: "needs_clarification", answer: "¿Entre qué ciudades o países querés comparar la temperatura?", weather: null };
      }
      if (requestedLocations.length > 1) {
        const results = await Promise.all(requestedLocations.map((location) =>
          answerWeatherQuestion({ question: `temperatura actual en ${location}` })));
        const ambiguous = results.find((result) => result?.status === "location_ambiguous");
        if (ambiguous) return ambiguous;
        const entries = results.map((result, index) => ({ name: requestedLocations[index], result }));
        const available = entries.filter(({ result }) => result?.status === "ok" && result.weather);
        const lines = entries.map(({ name, result }) => result?.status === "ok"
          ? result.answer
          : `${name}: no pude obtener información meteorológica.`);
        const warmest = available.reduce((best, entry) => {
          const temperature = entry.result.weather.current?.temperature;
          return Number.isFinite(temperature) && (!best || temperature > best.temperature)
            ? { name: locationLabel(entry.result.weather.location), temperature } : best;
        }, null);
        if (warmest) lines.push(`La más cálida ahora es ${warmest.name} (${formatTemperature(warmest.temperature)}).`);
        return {
          status: available.length ? "ok" : "weather_unavailable",
          answer: lines.join(" "),
          weather: available.length ? { type: "weather_response", intent: intent.intent, period: WEATHER_INTENTS.CURRENT,
            locations: available.map(({ result }) => result.weather), source: "Open-Meteo.com" } : null,
        };
      }
      const asksCurrentLocation = /\b(?:mi ubicacion(?: actual)?|donde estoy|donde me encuentro|aqui|aca)\b/.test(
        question.toLocaleLowerCase("es-AR").normalize("NFD").replace(/\p{Diacritic}/gu, ""),
      );
      let place;
      const requestedLocation = requestedLocations[0] || intent.location;
      if (requestedLocation) {
        place = await resolvePlace(requestedLocation);
      } else if (asksCurrentLocation) {
        return { status: "location_not_found", answer: "Para consultar tu ubicación actual necesito identificar primero una localidad de Argentina. Decime la ciudad y la provincia.", weather: { type: "weather_response", intent: intent.intent, needsClarification: true, source: "GeoNames" } };
      } else {
        place = await resolvePlace(defaultLocation);
        place.source = "default";
      }

      const forecast = await weatherService.getForecast(place.latitude, place.longitude);
      const period = intent.period;
      const localIntent = { ...intent };
      if (localIntent.date && !localIntent.dateHasExplicitYear && forecast.days[0]?.date) {
        const localToday = forecast.days[0].date;
        const monthDay = localIntent.date.slice(5);
        let year = Number(localToday.slice(0, 4));
        let localDate = `${year}-${monthDay}`;
        if (localDate < localToday) {
          year += 1;
          localDate = `${year}-${monthDay}`;
        }
        localIntent.date = localDate;
      }
      const selectedItems = selectDays(forecast, localIntent);
      const days = period === WEATHER_INTENTS.HOURLY ? [] : selectedItems.map(dayForCard);
      const hours = period === WEATHER_INTENTS.HOURLY ? selectedItems.map(hourForCard) : [];
      const showCurrent = period === WEATHER_INTENTS.CURRENT;
      const weather = {
        type: "weather_response",
        intent: intent.intent,
        period,
        periodLabel: periodLabel(period, intent.dayOffset),
        location: formatLocation(place),
        timezone: forecast.timezone,
        updatedAt: forecast.fetchedAt,
        icon: showCurrent ? currentForCard(forecast.current).icon : days[0]?.icon || hours[0]?.icon || "🌡️",
        current: showCurrent ? currentForCard(forecast.current) : null,
        days,
        hours,
        source: "Open-Meteo.com",
        usedDefaultLocation: place.source === "default",
      };
      return { status: "ok", answer: buildAnswer(weather), weather };
    } catch (error) {
      if (error instanceof WeatherLocationError) {
        if (error.code === "location_ambiguous") return clarifyLocation(question, error.candidates);
        if (error.code === "province_mismatch") {
          const actual = error.candidates[0]?.admin1;
          return { status: "location_ambiguous", answer: `GeoNames ubicó esa localidad en ${actual || "otra provincia"}. Decime el nombre de la ciudad y la provincia que querés consultar.`, weather: { type: "weather_response", intent: intent.intent, needsClarification: true, candidates: error.candidates, source: "GeoNames" } };
        }
        if (error.code === "country_not_supported") {
          return { status: "location_not_found", answer: "Por ahora solo puedo consultar localidades de Argentina.", weather: { type: "weather_response", intent: intent.intent, needsClarification: true, source: "GeoNames" } };
        }
        if (error.code === "geonames_auth_failed") {
          return { status: "weather_unavailable", answer: "No pude consultar GeoNames. Revisá la configuración del servicio meteorológico.", weather: null };
        }
        if (error.code === "geonames_not_configured") {
          return { status: "weather_unavailable", answer: "Falta configurar GeoNames en el backend para consultar el clima.", weather: null };
        }
        if (error.code === "location_not_found") {
          return {
            status: "location_not_found",
            answer: `No encontré esa localidad. Decime el nombre junto con su provincia o país.`,
            weather: { type: "weather_response", intent: intent.intent, needsClarification: true, source: "GeoNames" },
          };
        }
        if (error.code === "geocoding_unavailable") {
          return { status: "weather_unavailable", answer: "No pude identificar la localidad en GeoNames en este momento. Probá de nuevo más tarde.", weather: null };
        }
      }
      if (error instanceof WeatherApiError || error instanceof WeatherLocationError) {
        return {
          status: "weather_unavailable",
          answer: "No pude obtener el pronóstico de Open-Meteo en este momento. Probá de nuevo más tarde.",
          weather: null,
        };
      }
      console.error("[Weather] request failed:", error.name || "Error");
      return {
        status: "weather_unavailable",
        answer: "No pude obtener el pronóstico en este momento. Probá de nuevo más tarde.",
        weather: null,
      };
    }
  };
}

export { detectWeatherIntent, WEATHER_INTENTS };

