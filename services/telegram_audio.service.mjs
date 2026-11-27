const MAX_AUDIO_BYTES = 14 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/ogg", "application/ogg", "audio/opus", "audio/mpeg", "audio/mp3",
  "audio/mp4", "audio/m4a", "audio/aac", "audio/wav", "audio/x-wav",
  "audio/flac", "audio/webm",
]);

function audioError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizedMimeType(value) {
  const mime = String(value || "audio/ogg").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_AUDIO_TYPES.has(mime)) {
    throw audioError("unsupported_telegram_audio_type", "Unsupported Telegram audio type");
  }
  if (mime === "application/ogg") return "audio/ogg";
  if (mime === "audio/x-wav") return "audio/wav";
  return mime;
}

function safeTelegramFilePath(value) {
  if (typeof value !== "string" || value.length > 512
      || !/^[A-Za-z0-9_./-]+$/.test(value)
      || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw audioError("invalid_telegram_file_path", "Telegram returned an invalid file path");
  }
  return value.split("/").map(encodeURIComponent).join("/");
}

async function readBounded(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw audioError("telegram_audio_too_large", "Telegram audio exceeds the supported size");
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw audioError("telegram_audio_too_large", "Telegram audio exceeds the supported size");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw audioError("telegram_audio_too_large", "Telegram audio exceeds the supported size");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

export async function transcribeTelegramVoice({
  voice,
  config,
  botToken,
  fetchImpl = fetch,
}) {
  if (!voice?.fileId || typeof voice.fileId !== "string" || voice.fileId.length > 256) {
    throw new Error("Telegram voice file identifier is invalid");
  }
  if (voice.fileSize && voice.fileSize > MAX_AUDIO_BYTES) {
    throw audioError("telegram_audio_too_large", "Telegram voice file exceeds the supported size");
  }
  if (!config.geminiApiKey) {
    throw audioError("telegram_audio_not_configured", "Gemini audio transcription is not configured");
  }
  const mimeType = normalizedMimeType(voice.mimeType);

  const fileInfoResponse = await fetchImpl(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(voice.fileId)}`,
    { signal: AbortSignal.timeout(10000) },
  );
  const fileInfo = await readJson(fileInfoResponse);
  if (!fileInfoResponse.ok || !fileInfo?.ok || typeof fileInfo.result?.file_path !== "string") {
    throw new Error("Telegram getFile failed");
  }
  if (Number(fileInfo.result.file_size) > MAX_AUDIO_BYTES) {
    throw audioError("telegram_audio_too_large", "Telegram voice file exceeds the supported size");
  }

  const path = safeTelegramFilePath(fileInfo.result.file_path);
  const fileResponse = await fetchImpl(
    `https://api.telegram.org/file/bot${botToken}/${path}`,
    { signal: AbortSignal.timeout(20000) },
  );
  if (!fileResponse.ok) throw new Error("Telegram audio download failed");
  const bytes = await readBounded(fileResponse, MAX_AUDIO_BYTES);
  if (!bytes.byteLength) throw audioError("empty_telegram_audio", "Telegram returned an empty audio file");

  const model = config.model || "gemini-3.5-flash-lite";
  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": config.geminiApiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: "Transcribí fielmente el audio en su idioma original. Devolvé solo las palabras habladas, sin resumen, etiquetas ni comentarios. Conservá nombres propios y el español rioplatense." },
          { inline_data: { mime_type: mimeType, data: Buffer.from(bytes).toString("base64") } },
        ] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024 },
      }),
      signal: AbortSignal.timeout(45000),
    },
  );
  const payload = await readJson(response);
  if (!response.ok) {
    const error = audioError(
      response.status === 429 || response.status >= 500
        ? "telegram_audio_transcription_retryable"
        : "telegram_audio_transcription_failed",
      "Gemini audio transcription failed",
    );
    throw error;
  }
  const text = (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join(" ")
    .trim();
  if (!text || text.length > 400) {
    throw audioError("telegram_audio_transcription_failed", "Gemini returned no usable transcript");
  }
  return text;
}
