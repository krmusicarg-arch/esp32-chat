export default async function entorno(req, res) {
  if (typeof process.loadEnvFile === "function" && !process.env.TAVILY_API_KEY) {
    try {
      process.loadEnvFile();
    } catch {
      // .env no existe o ya cargado
    }
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "*",
    });
    res.end();
    return;
  }

  const env = {};
  for (const key of Object.keys(process.env).sort()) {
    env[key] = process.env[key];
  }

  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(env, null, 2));
}
