# Backend Gemini + Tavily para Vercel

Este backend mantiene la conversación en Gemini y ofrece una herramienta
`web_search` para que Gemini decida cuándo consultar Tavily. El firmware solo
envía `{ "question": "...", "history": [...] }` y sigue recibiendo
`{ "answer", "searched_web", "sources", "status" }`.

El identificador existente `gemini-3.5-flash-lite` se conserva. La ficha oficial
lo muestra como modelo estable y compatible con Function Calling; la búsqueda
se ejecuta en Tavily, no mediante Google Search Grounding.

## Arquitectura

- `api/chat.mjs`: función Vercel en `POST /api/chat`.
- `lib/assistant.mjs`: autenticación, contexto, selección de búsqueda, límites y síntesis.
- `tools/web_search.js`: cliente HTTPS de Tavily Search y Usage.
- `lib/redis_store.mjs`: contadores, reserva atómica, bloqueo de duplicados y caché en Upstash Redis.
- `server.mjs`: adaptador opcional para ejecutar el mismo handler localmente.

No se guardan contadores en archivos ni en memoria de las instancias. Si Redis o
el endpoint de uso de Tavily no están disponibles, el backend falla de forma
segura y no comienza una búsqueda nueva.

## Desplegar en Vercel Hobby

1. Crea un proyecto Vercel cuyo **Root Directory** sea
   `Arduino/examples/asistente_gemini/backend`.
2. Vincula una base Upstash Redis gratuita desde Vercel Marketplace o la consola
   Upstash. Configura la URL REST HTTPS y su token de acceso.
3. En **Settings → Environment Variables**, agrega:

   | Variable | Requerida | Valor/uso |
   | --- | --- | --- |
   | `GEMINI_API_KEY` | Sí | Clave de Gemini, solo en Vercel |
   | `TAVILY_API_KEY` | Sí | Clave de Tavily, solo en Vercel |
   | `ASSISTANT_DEVICE_TOKEN` | Sí | Token aleatorio, mínimo 24 caracteres |
   | `UPSTASH_REDIS_REST_URL` | Sí | Endpoint REST HTTPS de Redis |
   | `UPSTASH_REDIS_REST_TOKEN` | Sí | Token de escritura de Redis |
   | `GEMINI_MODEL` | No | Por defecto `gemini-3.5-flash-lite` |
   | `ENABLE_TAVILY_SEARCH` | No | Activo por defecto; `false` lo desactiva |
   | `TAVILY_MAX_MONTHLY_CREDITS` | No | Por defecto 900; admite de 1 a 1000 |
   | `TAVILY_SEARCH_DEPTH` | No | `basic` por defecto; también `fast`, `ultra-fast`, `advanced` |
   | `TAVILY_MAX_RESULTS` | No | Por defecto 5; máximo 5 |
   | `MAX_ASSISTANT_REQUESTS_PER_DAY` | No | Por defecto 120; máximo 1000 |

4. Despliega y copia el dominio HTTPS asignado por Vercel.
5. En el sketch, reemplaza el host de ejemplo de
   `ASSISTANT_BACKEND_URL` por `https://<tu-proyecto>.vercel.app/api/chat`.
   Carga en `ASSISTANT_DEVICE_TOKEN` el mismo token configurado en Vercel y
   vuelve a compilar el firmware.

El firmware valida TLS con la raíz ISRG Root X1 y sincroniza la hora por NTP
antes de iniciar HTTPS. Si configuras un dominio con una cadena de confianza
distinta, actualiza el certificado raíz correspondiente; no desactives la
validación TLS.

Genera un token de dispositivo nuevo con:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

El token se incluye en el firmware y puede extraerse de su binario; úsalo solo
como control revocable. Para revocarlo, cambia `ASSISTANT_DEVICE_TOKEN` en
Vercel y actualiza el firmware. No pongas claves de Gemini, Tavily o Redis en
el sketch.

## Límites y costos

- El código fija por defecto un máximo propio de **900 créditos por mes** y
  nunca permite configurar más de 1000. Consulta `/usage` antes de buscar y
  reserva los créditos con una operación Redis atómica. Después concilia el
  valor con `usage.credits` de Tavily.
- La documentación de Tavily indica que `basic`, `fast` y `ultra-fast`
  consumen 1 crédito por búsqueda; `advanced`, 2. El nivel gratuito publicado
  incluye 1000 créditos mensuales. El límite de 900 deja margen para proteger
  la cuenta; los planes y condiciones pueden cambiar, así que verifica la
  consola y los enlaces oficiales antes de desplegar.
- No se configura Pay-as-you-go ni se reintentan errores. Un error de cuota
  432/433 bloquea búsquedas durante el período local; deja desactivada la
  facturación Pay-as-you-go en Tavily. El código no puede cambiar ajustes de
  facturación de la cuenta.
- Los contadores se segmentan por mes calendario UTC. Si el ciclo real de
  facturación de Tavily reinicia antes del siguiente mes calendario, el
  contador local puede pausar búsquedas de forma conservadora hasta ese cambio.
- Hay además un límite diario persistente de solicitudes totales para proteger
  el uso de Gemini.
- Ese límite no cambia la facturación de Google: las cuotas gratis y los modelos
  disponibles dependen del proyecto y pueden cambiar. Para garantizar que Google
  no facture, mantén la clave en un proyecto sin facturación habilitada y revisa
  las cuotas en AI Studio. Este backend no activa facturación ni configura pagos.
- Una reserva que no puede conciliarse (por ejemplo, se pierde la conexión
  después de iniciar una búsqueda) queda contabilizada hasta el próximo período
  como comportamiento fail-closed.

## Caché y contexto

Redis conserva resultados de búsqueda, no conversaciones completas. Las claves
se generan con hashes de las consultas y expiran según el tipo detectado:

- Actualidad general: 6 horas.
- Precios: 5 minutos; la búsqueda solicita contenido en vivo a Tavily.
- Deportes/fixture: 30 minutos.
- Información institucional: 24 horas.

El historial que el firmware envía se conserva en el prompt. Los seguimientos
usan ese contexto para construir la consulta. Una consulta repetida usa los
resultados almacenados sin gastar créditos Tavily mientras el TTL siga vigente.

## Pruebas

Desde esta carpeta:

```powershell
npm test
```

Las pruebas usan respuestas simuladas; no envían preguntas a Gemini o Tavily ni
requieren claves.

Para una prueba manual en Postman:

- `POST https://<tu-proyecto>.vercel.app/api/chat`
- Header `Content-Type: application/json`
- Header `Authorization: Bearer <ASSISTANT_DEVICE_TOKEN>`
- Body raw JSON:

```json
{
  "question": "¿Qué partidos importantes hay este fin de semana?",
  "history": []
}
```

Una pregunta general como “¿Qué es un amplificador clase D?” debe contestarse
sin llamar a Tavily. En una consulta actual, la respuesta debe traer
`searched_web: true` y `sources` con títulos y enlaces HTTPS.

## Documentación oficial consultada

- [Gemini Function Calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Modelos Gemini](https://ai.google.dev/gemini-api/docs/models)
- [Precios y nivel gratuito de Gemini API](https://ai.google.dev/gemini-api/docs/pricing)
- [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Tavily Usage API](https://docs.tavily.com/documentation/api-reference/endpoint/usage)
- [Tavily créditos y precios](https://docs.tavily.com/documentation/api-credits)
- [Upstash Redis REST](https://upstash.com/docs/redis/features/restapi)
- [Vercel Functions](https://vercel.com/docs/functions)
