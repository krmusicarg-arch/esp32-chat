import test from "node:test";
import assert from "node:assert/strict";
import {
  MUSIC_INTENTS,
  SUPPORTED_PROVIDERS,
  detectMusicIntent,
  buildMusicResponse,
  validateMusicAction,
  validateMusicResponse,
  parseSongDetails,
} from "./services/music_assistant.mjs";

test("1. Prueba: 'Quiero escuchar música'", async () => {
  const intent = detectMusicIntent("Quiero escuchar música");
  assert.ok(intent, "Debe detectar intención musical");
  assert.equal(intent.intent, MUSIC_INTENTS.MUSIC_DISCOVERY);

  const response = await buildMusicResponse({
    intentData: intent,
    assistantAnswer: "¿Qué te gustaría escuchar? Puedo ayudarte a buscar música o abrir tu reproductor.",
  });
  assert.ok(response);
  assert.equal(response.type, "music_response");
  assert.equal(response.intent, MUSIC_INTENTS.MUSIC_DISCOVERY);
  assert.ok(response.actions.length >= 2, "Debe ofrecer YouTube Music y Spotify");
  const providers = response.actions.map((a) => a.provider);
  assert.ok(providers.includes(SUPPORTED_PROVIDERS.YOUTUBE_MUSIC));
  assert.ok(providers.includes(SUPPORTED_PROVIDERS.SPOTIFY));
});

test("2. Prueba: 'Robert, reproducí Fortunate Son'", async () => {
  const intent = detectMusicIntent("Robert, reproducí Fortunate Son");
  assert.ok(intent);
  assert.equal(intent.intent, MUSIC_INTENTS.MUSIC_SEARCH);
  assert.equal(intent.title, "Fortunate Son");
  assert.equal(intent.artist, "Creedence Clearwater Revival");

  const response = await buildMusicResponse({
    intentData: intent,
    assistantAnswer: "Preparé Fortunate Son de Creedence Clearwater Revival.",
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: [{
      trackName: "Fortunate Son",
      artistName: "Creedence Clearwater Revival",
      primaryGenreName: "Rock",
      artworkUrl100: "https://is1-ssl.mzstatic.com/image/100x100bb.jpg",
    }] }) }),
  });
  assert.ok(response);
  assert.equal(response.title, "Fortunate Son");
  assert.equal(response.artist, "Creedence Clearwater Revival");
  assert.equal(response.actions.length, 2);
  const ytAction = response.actions.find((a) => a.provider === SUPPORTED_PROVIDERS.YOUTUBE_MUSIC);
  assert.ok(ytAction);
  assert.equal(ytAction.label, "Abrir en YouTube Music");
  assert.ok(ytAction.url.includes("Fortunate"));

  const spotifyAction = response.actions.find((a) => a.provider === SUPPORTED_PROVIDERS.SPOTIFY);
  assert.ok(spotifyAction);
  assert.equal(spotifyAction.label, "Abrir en Spotify");
  assert.equal(spotifyAction.url, "https://open.spotify.com/search/Fortunate%20Son%20Creedence%20Clearwater%20Revival");
});

test("3. Prueba: 'Poné música de Creedence'", async () => {
  const intent = detectMusicIntent("Poné música de Creedence");
  assert.ok(intent);
  assert.equal(intent.intent, MUSIC_INTENTS.MUSIC_SEARCH);
  assert.equal(intent.artist, "Creedence");

  const response = await buildMusicResponse({
    intentData: intent,
    assistantAnswer: "Preparé música de Creedence.",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ results: [{
        trackName: "Fortunate Son",
        artistName: "Creedence Clearwater Revival",
        primaryGenreName: "Rock",
        artworkUrl100: "https://is1-ssl.mzstatic.com/image/100x100bb.jpg",
      }] }),
    }),
  });
  assert.ok(response);
  assert.equal(response.title, "Fortunate Son");
  assert.equal(response.artist, "Creedence Clearwater Revival");
  assert.ok(response.imageUrl);
  assert.ok(response.actions.some((a) => a.label === "Abrir en YouTube Music"));
  assert.ok(response.actions.some((a) => a.label === "Abrir en Spotify"));
});

test("4. Prueba: 'Buscá Highway to Hell de AC/DC'", async () => {
  const intent = detectMusicIntent("Buscá Highway to Hell de AC/DC");
  assert.ok(intent);
  assert.equal(intent.intent, MUSIC_INTENTS.MUSIC_SEARCH);
  assert.equal(intent.title, "Highway to Hell");
  assert.equal(intent.artist, "AC/DC");

  const response = await buildMusicResponse({
    intentData: intent,
    assistantAnswer: "Preparé Highway to Hell de AC/DC.",
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: [{
      trackName: "Highway to Hell",
      artistName: "AC/DC",
      primaryGenreName: "Rock",
      artworkUrl100: "https://is1-ssl.mzstatic.com/image/100x100bb.jpg",
    }] }) }),
  });
  assert.ok(response);
  assert.equal(response.title, "Highway to Hell");
  assert.equal(response.artist, "AC/DC");
  assert.ok(response.actions.some((a) => a.label === "Abrir en YouTube Music"));
  assert.ok(response.actions.some((a) => a.label === "Abrir en Spotify"));
});

test("5. Prueba: 'Quiero escuchar música de rock'", async () => {
  const intent = detectMusicIntent("Quiero escuchar música de rock");
  assert.ok(intent);
  assert.equal(intent.intent, MUSIC_INTENTS.MUSIC_SEARCH);
  assert.equal(intent.query.toLowerCase(), "rock");

  const response = await buildMusicResponse({
    intentData: intent,
    assistantAnswer: "Preparé una selección de rock.",
  });
  assert.ok(response);
  assert.ok(response.actions.some((a) => a.label === "Abrir en YouTube Music"));
  assert.ok(response.actions.some((a) => a.label === "Abrir en Spotify"));
});

test("6. Prueba: 'Quiero abrir Spotify'", async () => {
  const intent = detectMusicIntent("Quiero abrir Spotify");
  assert.ok(intent);
  assert.equal(intent.intent, MUSIC_INTENTS.MUSIC_OPEN_PROVIDER);
  assert.equal(intent.provider, SUPPORTED_PROVIDERS.SPOTIFY);

  const response = await buildMusicResponse({
    intentData: intent,
    assistantAnswer: "Podés abrir Spotify desde acá.",
  });
  assert.ok(response);
  assert.equal(response.actions.length, 1);
  const action = response.actions[0];
  assert.equal(action.provider, SUPPORTED_PROVIDERS.SPOTIFY);
  assert.equal(action.action, "manual_open");
  assert.equal(action.label, "Abrir en Spotify");
  assert.equal(action.url, "https://open.spotify.com");
});

test("7. Prueba: Consulta normal que no sea musical", () => {
  assert.equal(detectMusicIntent("¿Qué hora es?"), null);
  assert.equal(detectMusicIntent("¿Quién cumple años mañana?"), null);
  assert.equal(detectMusicIntent("Agregá comprar leche a la lista de tareas"), null);
  assert.equal(detectMusicIntent("¿Cómo está el clima hoy?"), null);
});

test("8. Prueba: Proveedor desconocido", () => {
  const actionWithUnknownProvider = {
    id: "tidal_open",
    provider: "tidal",
    action: "manual_open",
    label: "Abrir en Tidal",
    url: "https://listen.tidal.com",
  };
  assert.equal(
    validateMusicAction(actionWithUnknownProvider),
    false,
    "Debe rechazar proveedores no soportados como Tidal"
  );
});

test("9. Prueba: Acción con URL inválida o no permitida", () => {
  // URL no HTTPS
  assert.equal(
    validateMusicAction({
      id: "test_http",
      provider: SUPPORTED_PROVIDERS.YOUTUBE_MUSIC,
      action: "search",
      label: "Abrir en YouTube Music",
      url: "http://music.youtube.com/search?q=test",
    }),
    false
  );

  // Dominio no autorizado (arbitrario)
  assert.equal(
    validateMusicAction({
      id: "test_arbitrary",
      provider: SUPPORTED_PROVIDERS.YOUTUBE_MUSIC,
      action: "search",
      label: "Abrir en YouTube Music",
      url: "https://sitio-malicioso.com/musica",
    }),
    false
  );

  // Spotify intentando búsqueda en vez de manual_open
  assert.equal(
    validateMusicAction({
      id: "spotify_search",
      provider: SUPPORTED_PROVIDERS.SPOTIFY,
      action: "search",
      label: "Buscar en Spotify",
      url: "https://open.spotify.com/search",
    }),
    false
  );
});

test("10. No confirma una canción si el catálogo no encuentra coincidencia", async () => {
  const intent = detectMusicIntent("Buscá una canción inexistente de Artista inventado");
  const response = await buildMusicResponse({
    intentData: intent,
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) }),
  });

  assert.equal(response.found, false);
  assert.equal(response.title, "");
  assert.match(response.message, /No pude confirmar un tema/);
  assert.ok(response.actions.some((action) => action.url.startsWith("https://music.youtube.com/search?q=")));
  assert.ok(response.actions.some((action) => action.url.startsWith("https://open.spotify.com/search/")));
});

test("11. Rechaza dominios lookalike e imágenes fuera del catálogo permitido", () => {
  const maliciousAction = {
    id: "youtube_music_open",
    provider: SUPPORTED_PROVIDERS.YOUTUBE_MUSIC,
    action: "search",
    label: "Abrir en YouTube Music",
    url: "https://music.youtube.com.attacker.example/search?q=rock",
  };
  assert.equal(validateMusicAction(maliciousAction), false);

  const response = validateMusicResponse({
    type: "music_response",
    intent: MUSIC_INTENTS.MUSIC_SEARCH,
    title: "Canción",
    artist: "Artista",
    imageUrl: "https://attacker.example/cover.png",
    message: "Encontré una canción.",
    found: true,
    actions: [{
      id: "youtube_music_open",
      provider: SUPPORTED_PROVIDERS.YOUTUBE_MUSIC,
      action: "search",
      label: "Abrir en YouTube Music",
      url: "https://music.youtube.com/search?q=rock",
    }],
  });
  assert.equal(response.imageUrl, null);
});

test("12. Interpreta 'música de la banda de Creedence' como búsqueda del artista", () => {
  const intent = detectMusicIntent("Robert, quiero escuchar música de la banda de Creedence");
  assert.equal(intent.intent, MUSIC_INTENTS.MUSIC_SEARCH);
  assert.equal(intent.artist, "Creedence");
  assert.equal(intent.query, "Creedence");
});
