import test from "node:test";
import assert from "node:assert/strict";
import { transcribeTelegramVoice } from "./services/telegram_audio.service.mjs";

test("downloads Telegram voice safely and transcribes it through the configured Gemini service", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes("getFile")) {
      return Response.json({ ok: true, result: { file_path: "voice/file_1.oga", file_size: 4 } });
    }
    if (String(url).includes("/file/bot")) {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "application/octet-stream", "content-length": "4" },
      });
    }
    return Response.json({
      candidates: [{ content: { parts: [{ text: "Robert, avisale a Karina que llego tarde." }] } }],
    });
  };
  const transcript = await transcribeTelegramVoice({
    voice: { fileId: "file-id", fileSize: 4, mimeType: "audio/ogg" },
    config: { geminiApiKey: "test-key", model: "gemini-3.5-flash-lite" },
    botToken: "test-token",
    fetchImpl,
  });
  assert.equal(transcript, "Robert, avisale a Karina que llego tarde.");
  assert.match(requests[0].url, /getFile\?file_id=file-id$/);
  assert.match(requests[1].url, /\/file\/bottest-token\/voice\/file_1\.oga$/);
  const geminiRequest = JSON.parse(requests[2].options.body);
  assert.equal(geminiRequest.contents[0].parts[1].inline_data.mime_type, "audio/ogg");
  assert.equal(geminiRequest.contents[0].parts[1].inline_data.data, Buffer.from([1, 2, 3, 4]).toString("base64"));
  assert.equal(requests[2].options.headers["x-goog-api-key"], "test-key");
});

test("rejects oversized voice files before downloading or sending them to Gemini", async () => {
  let fetchCount = 0;
  await assert.rejects(transcribeTelegramVoice({
    voice: { fileId: "file-id", fileSize: 15 * 1024 * 1024, mimeType: "audio/ogg" },
    config: { geminiApiKey: "test-key", model: "gemini-3.5-flash-lite" },
    botToken: "test-token",
    fetchImpl: async () => { fetchCount += 1; },
  }), /exceeds the supported size/);
  assert.equal(fetchCount, 0);
});

test("rejects unsafe paths returned by Telegram instead of fetching arbitrary URLs", async () => {
  let fetchCount = 0;
  await assert.rejects(transcribeTelegramVoice({
    voice: { fileId: "file-id", fileSize: 4, mimeType: "audio/ogg" },
    config: { geminiApiKey: "test-key", model: "gemini-3.5-flash-lite" },
    botToken: "test-token",
    fetchImpl: async () => {
      fetchCount += 1;
      return Response.json({ ok: true, result: { file_path: "../outside", file_size: 4 } });
    },
  }), /invalid file path/);
  assert.equal(fetchCount, 1);
});
