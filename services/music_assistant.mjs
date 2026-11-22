/**
 * Módulo music_assistant
 * 
 * Responsabilidades:
 * - Detectar intenciones musicales: MUSIC_DISCOVERY, MUSIC_RECOMMENDATION, MUSIC_OPEN_PROVIDER, MUSIC_SEARCH, MUSIC_HELP.
 * - Clasificar solicitudes y extraer nombre de canción, artista, género o consulta.
 * - Enriquecer metadatos con imagen de portada si está disponible.
 * - Validar proveedores y acciones permitidas contra una allowlist estricta.
 * - Generar URLs HTTPS seguras y codificadas.
 * - Regla Spotify: solo apertura manual ("Abrir en Spotify", sin búsquedas por voz ni control de reproducción).
 * - Regla YouTube Music: enlace directo o de búsqueda ("Abrir en YouTube Music").
 * - No afirmar que la música se está reproduciendo.
 */

export const MUSIC_INTENTS = {
  MUSIC_DISCOVERY: "MUSIC_DISCOVERY",
  MUSIC_RECOMMENDATION: "MUSIC_RECOMMENDATION",
  MUSIC_OPEN_PROVIDER: "MUSIC_OPEN_PROVIDER",
  MUSIC_SEARCH: "MUSIC_SEARCH",
  MUSIC_HELP: "MUSIC_HELP",
};

export const SUPPORTED_PROVIDERS = {
  YOUTUBE_MUSIC: "youtube_music",
  SPOTIFY: "spotify",
};

const KNOWN_GENRES = new Set([
  "rock",
  "pop",
  "jazz",
  "blues",
  "metal",
  "heavy metal",
  "reggae",
  "clasica",
  "musica clasica",
  "folklore",
  "tango",
  "cumbia",
  "trap",
  "rap",
  "hip hop",
  "electronica",
  "indie",
  "punk",
]);

// Mapa de canciones muy populares para inferencia rápida de artista
const POPULAR_TRACK_ARTISTS = {
  "fortunate son": "Creedence Clearwater Revival",
  "highway to hell": "AC/DC",
  "bohemian rhapsody": "Queen",
  "back in black": "AC/DC",
  "smells like teen spirit": "Nirvana",
  "hotel california": "Eagles",
  "sweet child o mine": "Guns N' Roses",
  "ji ji ji": "Patricio Rey y sus Redonditos de Ricota",
  "de musica ligera": "Soda Stereo",
};

export function normalizeMusicText(text) {
  if (typeof text !== "string") return "";
  return text
    .toLocaleLowerCase("es-AR")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{Letter}\p{Number}\s]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Limpia saludos e invocaciones como "Robert, ..." o "Robertito ..."
 */
export function cleanAssistantInvocation(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/^robert(?:ito)?[\s,.:;!?-]+/i, "")
    .replace(/^hola\s+robert(?:ito)?[\s,.:;!?-]+/i, "")
    .replace(/^por\s+favor[\s,.:;!?-]+/i, "")
    .trim();
}

/**
 * Valida que una acción musical cumpla con el contrato y las restricciones de seguridad.
 */
export function validateMusicAction(action) {
  if (!action || typeof action !== "object") return false;
  if (typeof action.id !== "string" || !action.id.trim()) return false;
  if (!Object.values(SUPPORTED_PROVIDERS).includes(action.provider)) return false;
  if (typeof action.label !== "string" || !action.label.trim()) return false;
  if (typeof action.action !== "string" || !["search", "manual_open", "open_track"].includes(action.action)) {
    return false;
  }

  // Validación estricta de URL HTTPS
  if (typeof action.url !== "string" || !action.url.startsWith("https://")) return false;
  try {
    const parsed = new URL(action.url);
    if (parsed.protocol !== "https:") return false;
    const expectedHost = action.provider === SUPPORTED_PROVIDERS.YOUTUBE_MUSIC ? "music.youtube.com" : "open.spotify.com";
    const isAllowed = parsed.hostname === expectedHost;
    if (!isAllowed) return false;
  } catch {
    return false;
  }

  // Restricciones específicas de proveedor:
  // Spotify solo admite manual_open (no búsquedas generadas por voz ni control de reproducción)
  if (action.provider === SUPPORTED_PROVIDERS.SPOTIFY && action.action !== "manual_open") {
    return false;
  }

  return true;
}

/**
 * Valida un payload de respuesta musical completo.
 */
export function validateMusicResponse(musicResponse) {
  if (!musicResponse || typeof musicResponse !== "object") return null;
  if (musicResponse.type !== "music_response") return null;
  if (!Object.values(MUSIC_INTENTS).includes(musicResponse.intent)) return null;
  if (typeof musicResponse.message !== "string") return null;
  if (!Array.isArray(musicResponse.actions)) return null;

  const validActions = musicResponse.actions.filter(validateMusicAction);
  if (validActions.length === 0) return null;

  // Validación de imagen si existe
  let validImageUrl = null;
  if (typeof musicResponse.imageUrl === "string") {
    try {
      const imageUrl = new URL(musicResponse.imageUrl);
      if (imageUrl.protocol === "https:" && imageUrl.hostname.endsWith(".mzstatic.com")) validImageUrl = imageUrl.href;
    } catch {
      // Ignorar imágenes con URL no válida.
    }
  }

  return {
    type: "music_response",
    intent: musicResponse.intent,
    title: typeof musicResponse.title === "string" ? musicResponse.title.trim() : "",
    artist: typeof musicResponse.artist === "string" ? musicResponse.artist.trim() : "",
    imageUrl: validImageUrl,
    message: musicResponse.message.trim(),
    found: musicResponse.found !== false,
    actions: validActions,
  };
}

/**
 * Genera URL segura para YouTube Music
 */
export function buildYouTubeMusicUrl(query = "") {
  const trimmed = query.trim();
  if (!trimmed) {
    return "https://music.youtube.com";
  }
  return `https://music.youtube.com/search?q=${encodeURIComponent(trimmed)}`;
}

/**
 * Genera URL para Spotify (apertura manual)
 */
export function buildSpotifyUrl() {
  return "https://open.spotify.com";
}

export function buildSpotifySearchUrl(query = "") {
  const trimmed = query.trim();
  return trimmed ? `https://open.spotify.com/search/${encodeURIComponent(trimmed)}` : buildSpotifyUrl();
}

/**
 * Crea una acción segura para YouTube Music
 */
export function createYouTubeMusicAction(query = "") {
  const trimmed = query.trim();
  return {
    id: "youtube_music_open",
    provider: SUPPORTED_PROVIDERS.YOUTUBE_MUSIC,
    action: trimmed ? "open_track" : "search",
    label: "Abrir en YouTube Music",
    query: trimmed,
    url: buildYouTubeMusicUrl(trimmed),
  };
}

/**
 * Crea una acción de apertura manual para Spotify
 */
export function createSpotifyAction(query = "") {
  return {
    id: "spotify_open",
    provider: SUPPORTED_PROVIDERS.SPOTIFY,
    action: "manual_open",
    label: "Abrir en Spotify",
    url: buildSpotifySearchUrl(query),
  };
}

/**
 * Extrae detalles de la canción, artista o género del texto.
 */
export function parseSongDetails(raw) {
  let cleaned = cleanAssistantInvocation(raw);

  // Quitar sufijos de proveedores y cortesías
  cleaned = cleaned
    .replace(/\s+en\s+youtube\s*music\b/gi, "")
    .replace(/\s+en\s+youtube\b/gi, "")
    .replace(/\s+en\s+spotify\b/gi, "")
    .replace(/\s+(?:por\s+favor|por\s+fa)\b/gi, "")
    .trim();

  // Coincidencia con verbos musicales
  const verbMatch = cleaned.match(
    /^(?:reprodu[cct][ií](?:r)?|pon[eé](?:r)?|bus[cct][aá](?:r)?|escuchar|tocar|quiero\s+escuchar|tengo\s+ganas\s+de\s+escuchar)\s+(.+)/i
  );
  let payload = verbMatch ? verbMatch[1].trim() : cleaned;

  // 1. "música de <artista / género>" o "temas de <artista>"
  const musicDeMatch = payload.match(/^(?:(?:la\s+)?m[uú]sica\s+de|temas?\s+de|canci[oó]n(?:es)?\s+de)\s+(.+)/i);
  if (musicDeMatch) {
    const subject = musicDeMatch[1].trim().replace(/^(?:(?:la|una)\s+)?banda\s+de\s+/i, "");
    if (KNOWN_GENRES.has(subject.toLowerCase())) {
      return { type: "genre", genre: subject, title: `Música de ${subject}`, artist: "", query: subject };
    }
    return { type: "artist", title: "", artist: subject, query: subject };
  }

  // 2. "<canción> de <artista>" ej: "Highway to Hell de AC/DC"
  const deMatch = payload.match(/^(.+?)\s+de\s+(.+)$/i);
  if (deMatch) {
    const part1 = deMatch[1].trim();
    const part2 = deMatch[2].trim();
    if (/^m[uú]sica$/i.test(part1) && KNOWN_GENRES.has(part2.toLowerCase())) {
      return { type: "genre", genre: part2, title: `Música de ${part2}`, artist: "", query: part2 };
    }
    if (/^m[uú]sica$/i.test(part1)) {
      return { type: "artist", title: "", artist: part2, query: part2 };
    }
    return {
      type: "track_and_artist",
      title: part1,
      artist: part2,
      query: `${part1} ${part2}`,
    };
  }

  // 3. Descubrimiento general: "música" o "algo de música"
  if (/^(?:m[uú]sica|algo\s+de\s+m[uú]sica)$/i.test(payload)) {
    return { type: "discovery", title: "", artist: "", query: "" };
  }

  // 4. Solo título o artista inferido
  const normPayload = payload.toLowerCase();
  const knownArtist = POPULAR_TRACK_ARTISTS[normPayload] || "";
  return {
    type: "track_or_artist",
    title: payload,
    artist: knownArtist,
    query: knownArtist ? `${payload} ${knownArtist}` : payload,
  };
}

/**
 * Detecta la intención musical a partir del texto del usuario.
 */
export function detectMusicIntent(text) {
  const norm = normalizeMusicText(text);
  if (!norm) return null;

  // Identificar mención explícita de proveedor
  let requestedProvider = null;
  if (/\bspotify\b/i.test(norm)) {
    requestedProvider = SUPPORTED_PROVIDERS.SPOTIFY;
  } else if (/\byoutube\s*music\b|\byoutube\b/i.test(norm)) {
    requestedProvider = SUPPORTED_PROVIDERS.YOUTUBE_MUSIC;
  }

  // 1. Ayuda musical
  if (/\b(como\s+(?:puedo\s+)?escuchar\s+musica|que\s+reproductores|ayuda\s+con\s+la\s+musica)\b/i.test(norm)) {
    return {
      intent: MUSIC_INTENTS.MUSIC_HELP,
      provider: requestedProvider,
      title: "",
      artist: "",
      query: "",
    };
  }

  // 2. Apertura explícita de proveedor
  if (
    /\b(?:abrir|abri|abreme|lanzar|entra(?:r)?\s+a|acceder\s+a)\s+(?:la\s+app\s+de\s+|la\s+aplicacion\s+de\s+)?(?:mi\s+)?(spotify|youtube(?:\s*music)?)\b/i.test(norm) ||
    /\b(?:quiero\s+abrir|quiero\s+entrar\s+a)\s+(?:mi\s+)?(spotify|youtube(?:\s*music)?)\b/i.test(norm)
  ) {
    return {
      intent: MUSIC_INTENTS.MUSIC_OPEN_PROVIDER,
      provider: requestedProvider || SUPPORTED_PROVIDERS.SPOTIFY,
      title: "",
      artist: "",
      query: "",
    };
  }

  // 3. Recomendación musical
  const recMatch = norm.match(
    /\b(?:recomenda(?:me)?|sugeri(?:me)?|que\s+(?:musica|tema|cancion|banda|artista)\s+me\s+recomendas?)\s*(?:algo\s+de\s+|un\s+poco\s+de\s+)?(.*)/i
  );
  if (recMatch) {
    const genre = recMatch[1]
      ? recMatch[1].replace(/\b(?:para\s+escuchar|hoy|por\s+fa|por\s+favor|en\s+spotify|en\s+youtube(?:\s*music)?)\b/gi, "").trim()
      : "";
    return {
      intent: MUSIC_INTENTS.MUSIC_RECOMMENDATION,
      provider: requestedProvider,
      title: genre ? `Recomendación: ${genre}` : "Recomendaciones musicales",
      artist: "",
      query: genre,
    };
  }

  // 4. Búsqueda explícita o solicitud de reproducción / canción
  // ej: "Robert, reproducí Fortunate Son", "Poné música de Creedence", "Buscá Highway to Hell de AC/DC", "Quiero escuchar música de rock"
  if (
    /\b(?:reprodu[cct][ií]|pon[eé]|bus[cct][aá]|escuchar|tocar|quiero\s+escuchar|tengo\s+ganas\s+de\s+escuchar)\b/i.test(norm)
  ) {
    const details = parseSongDetails(text);

    if (details.type === "discovery") {
      return {
        intent: MUSIC_INTENTS.MUSIC_DISCOVERY,
        provider: requestedProvider,
        title: "",
        artist: "",
        query: "",
      };
    }

    if (details.type === "genre") {
      return {
        intent: MUSIC_INTENTS.MUSIC_SEARCH,
        provider: requestedProvider,
        title: details.title,
        artist: "",
        query: details.query,
      };
    }

    return {
      intent: MUSIC_INTENTS.MUSIC_SEARCH,
      provider: requestedProvider,
      title: details.title || "",
      artist: details.artist || "",
      query: details.query,
    };
  }

  // 5. Descubrimiento general: "quiero escuchar música", "tengo ganas de escuchar música"
  if (/\b(?:escuchar\s+musica|poner\s+musica|alguna\s+cancion|quiero\s+musica)\b/i.test(norm)) {
    return {
      intent: MUSIC_INTENTS.MUSIC_DISCOVERY,
      provider: requestedProvider,
      title: "",
      artist: "",
      query: "",
    };
  }

  return null;
}

/**
 * Enriquece metadatos (portada, título oficial, artista) con un fetch liviano a iTunes Search API.
 * Falla de forma totalmente segura y silenciosa si no hay conexión o se agota el timeout.
 */
export async function enrichMusicMetadata({ query, title, artist, fetchImpl = fetch }) {
  const searchTerm = [title, artist].filter(Boolean).join(" ") || query;
  if (!searchTerm) {
    return { title: title || "", artist: artist || "", imageUrl: null, found: false };
  }

  try {
    const res = await fetchImpl(
      `https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&entity=song&limit=1`,
      { signal: AbortSignal.timeout(1800) }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.results && data.results[0]) {
        const item = data.results[0];
        const stopWords = new Set(["a", "an", "and", "de", "del", "el", "la", "los", "las", "the", "to"]);
        const requestedTerms = normalizeMusicText(searchTerm).split(" ").filter((word) => word.length > 1 && !stopWords.has(word));
        const catalogTerms = new Set(normalizeMusicText([
          item.trackName,
          item.artistName,
          item.primaryGenreName,
        ].filter(Boolean).join(" ")).split(" "));
        const matches = requestedTerms.length > 0 && requestedTerms.every((word) => catalogTerms.has(word));
        return {
          title: item.trackName || title || "",
          artist: item.artistName || artist || "",
          imageUrl: item.artworkUrl100
            ? item.artworkUrl100.replace("100x100bb", "400x400bb")
            : null,
          found: Boolean(item.trackName && matches),
        };
      }
    }
  } catch {
    // Si falla o no hay conexión externa, usar los datos ya parseados
  }

  return {
    title: title || "",
    artist: artist || "",
    imageUrl: null,
    found: false,
  };
}

/**
 * Construye el payload estructurado de música a partir de la intención detectada.
 */
export async function buildMusicResponse({ intentData, assistantAnswer = "", fetchImpl = fetch }) {
  if (!intentData) return null;
  const { intent, provider, query, title = "", artist = "" } = intentData;

  // Enriquecer metadatos si tenemos búsqueda o título
  let enriched = { title, artist, imageUrl: null, found: false };
  if (intent === MUSIC_INTENTS.MUSIC_SEARCH || intent === MUSIC_INTENTS.MUSIC_RECOMMENDATION) {
    enriched = await enrichMusicMetadata({ query, title, artist, fetchImpl });
  }

  const found = Boolean(enriched.found);
  const finalTitle = found ? enriched.title || title : "";
  const finalArtist = found ? enriched.artist || artist : "";
  const finalQuery = [finalTitle, finalArtist].filter(Boolean).join(" ") || query;

  const actions = [];

  switch (intent) {
    case MUSIC_INTENTS.MUSIC_OPEN_PROVIDER:
      if (provider === SUPPORTED_PROVIDERS.SPOTIFY) {
        actions.push(createSpotifyAction());
      } else {
        actions.push(createYouTubeMusicAction());
      }
      break;

    case MUSIC_INTENTS.MUSIC_SEARCH:
      // Botón «Abrir en YouTube Music»
      actions.push(createYouTubeMusicAction(finalQuery));
      // Botón «Abrir en Spotify»
      actions.push(createSpotifyAction(finalQuery));
      break;

    case MUSIC_INTENTS.MUSIC_RECOMMENDATION:
      if (finalQuery) {
        actions.push(createYouTubeMusicAction(finalQuery));
      } else {
        actions.push(createYouTubeMusicAction());
      }
      actions.push(createSpotifyAction(finalQuery));
      break;

    case MUSIC_INTENTS.MUSIC_DISCOVERY:
    case MUSIC_INTENTS.MUSIC_HELP:
    default:
      actions.push(createYouTubeMusicAction());
      actions.push(createSpotifyAction());
      break;
  }

  const rawResponse = {
    type: "music_response",
    intent,
    title: finalTitle,
    artist: finalArtist,
    imageUrl: found ? enriched.imageUrl : null,
    found,
    message: found
      ? `Encontré ${finalTitle ? `${finalTitle}${finalArtist ? ` de ${finalArtist}` : ""}` : `una opción de ${finalQuery || "música"}`}. ¿Dónde querés escucharlo?`
      : intent === MUSIC_INTENTS.MUSIC_SEARCH || intent === MUSIC_INTENTS.MUSIC_RECOMMENDATION
        ? `No pude confirmar un tema para “${query || title || "esa búsqueda"}”. Podés buscarlo en YouTube Music o Spotify.`
        : assistantAnswer.trim() || "¿Qué te gustaría escuchar? Puedo abrir YouTube Music o Spotify.",
    actions,
  };

  return validateMusicResponse(rawResponse);
}
