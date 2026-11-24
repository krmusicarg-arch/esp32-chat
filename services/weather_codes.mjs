export const WEATHER_CODES = new Map([
  [0, ["Despejado", "☀️"]], [1, ["Mayormente despejado", "🌤️"]],
  [2, ["Parcialmente nublado", "⛅"]], [3, ["Nublado", "☁️"]],
  [45, ["Niebla", "🌫️"]], [48, ["Niebla engelante", "🌫️"]],
  [51, ["Llovizna ligera", "🌦️"]], [53, ["Llovizna moderada", "🌦️"]],
  [55, ["Llovizna intensa", "🌧️"]], [56, ["Llovizna helada", "🌧️"]],
  [57, ["Llovizna helada intensa", "🌧️"]], [61, ["Lluvia ligera", "🌦️"]],
  [63, ["Lluvia moderada", "🌧️"]], [65, ["Lluvia intensa", "🌧️"]],
  [66, ["Lluvia helada", "🌧️"]], [67, ["Lluvia helada intensa", "🌧️"]],
  [71, ["Nevada ligera", "🌨️"]], [73, ["Nevada moderada", "🌨️"]],
  [75, ["Nevada intensa", "❄️"]], [77, ["Granos de nieve", "🌨️"]],
  [80, ["Chaparrones ligeros", "🌦️"]], [81, ["Chaparrones moderados", "🌧️"]],
  [82, ["Chaparrones intensos", "⛈️"]], [85, ["Chaparrones de nieve", "🌨️"]],
  [86, ["Chaparrones fuertes de nieve", "❄️"]], [95, ["Tormenta", "⛈️"]],
  [96, ["Tormenta con granizo", "⛈️"]], [99, ["Tormenta fuerte con granizo", "⛈️"]],
]);

const UNKNOWN_CONDITION = Object.freeze({
  weatherCode: null,
  description: "Estado del tiempo no disponible",
  icon: "🌡️",
});

export function describeWeatherCode(code) {
  const numericCode = Number(code);
  if (code === null || code === undefined || !Number.isFinite(numericCode)) {
    return { ...UNKNOWN_CONDITION };
  }
  const [description, icon] = WEATHER_CODES.get(numericCode)
    || [UNKNOWN_CONDITION.description, UNKNOWN_CONDITION.icon];
  return { weatherCode: numericCode, description, icon };
}
