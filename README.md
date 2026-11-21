# Backend Gemini + Tavily para Vercel

Este backend mantiene la conversación en Gemini y ofrece una herramienta
`web_search` para que Gemini decida cuándo consultar Tavily. Conserva el
contrato anterior del firmware (`question`, `history`, `answer`, `searched_web`,
`sources`, `status`) y acepta campos opcionales `speaker_id` y
`conversation_id`. El selector del ESP32 envía `speaker_id`; el ID se valida
contra los cuatro integrantes activos en cada solicitud.

El identificador existente `gemini-3.5-flash-lite` se conserva. La ficha oficial
lo muestra como modelo estable y compatible con Function Calling; la búsqueda
se ejecuta en Tavily, no mediante Google Search Grounding.

## Arquitectura

- `server.mjs`: punto de entrada local existente; atiende `/health`, `/chat` y `/api/chat`.
- `api/chat.mjs`: función Vercel en `POST /api/chat`, usando el mismo handler.
- `api/members.mjs`: `GET /api/members`, roster para el selector manual.
- `api/notifications/`: consulta autenticada y ACK de entregas.
- `lib/assistant.mjs`: autenticación, contexto, selección de búsqueda, límites, síntesis y coordinación familiar.
- `tools/web_search.js`: cliente HTTPS de Tavily Search y Usage.
- `lib/redis_store.mjs`: contadores, reserva atómica, bloqueo de duplicados y caché en Upstash Redis.
- `database/` y `services/`: persistencia Supabase y gestión de familia, conversaciones, memoria, tareas, recordatorios y contexto proactivo.

Redis mantiene límites y caché de búsquedas; Supabase persiste conversaciones y
datos familiares en el esquema existente `family_assistant`. **No ejecutes
`database/schema.sql`: es una estructura anterior y no representa la base real.**
La migración incremental de `database/migrations/` es una propuesta para revisar
y ejecutar manualmente; este backend no modifica la base automáticamente. La
clave `service_role` se usa solo en el servidor.
La migración concede permisos de acceso al rol `service_role` únicamente dentro
de `family_assistant` y exige una clave de idempotencia única en
`notification_deliveries`. Si ya hay claves duplicadas, se detiene sin
corregirlas automáticamente. Antes de ejecutarla, coteja constraints, índices y
estados permitidos con el DDL vigente; no ejecutarla sobre producción sin
revisar ese resultado.

El ESP32 consulta `/api/notifications/pending` cada 30 segundos mientras está
conectado y en reposo. La base detecta vencimientos al atender ese polling,
aplica quiet hours y límites diarios y mantiene entregas individuales para los
cuatro integrantes. No es push: si el ESP32 está apagado o sin conexión, el
aviso se muestra cuando vuelva a consultar. Un solo ESP32 solo puede mostrar el
aviso del integrante seleccionado.

## Desplegar en Vercel Hobby

1. Usa el proyecto Supabase existente. Confirma que el esquema
   `family_assistant` tenga sus 19 tablas, exactamente cuatro integrantes
   activos y `family_settings.id = 1`, `expected_members = 4`. Confirma además
   que `family_assistant` esté permitido en los esquemas expuestos por la API
   REST y que el rol de backend tenga `USAGE`; el cliente selecciona el esquema
   mediante `Accept-Profile`/`Content-Profile`. No ejecutes
   `database/schema.sql`; corresponde a un esquema obsoleto. Revisa la
   migración incremental en `database/migrations/20261120_family_workflows.sql`
   y ejecútala manualmente solo después de comprobarla contra el DDL real y
   obtener aprobación.
2. Vincula una base Upstash Redis gratuita desde Vercel Marketplace o la consola
   Upstash. Configura la URL REST HTTPS y su token de acceso.
3. Configura Vercel con **Root Directory**
   `Arduino/examples/asistente_gemini/esp32-chat`.
4. En **Settings → Environment Variables**, agrega:

   | Variable | Requerida | Valor/uso |
   | --- | --- | --- |
   | `GEMINI_API_KEY` | Sí | Clave de Gemini, solo en Vercel |
   | `TAVILY_API_KEY` | Sí | Clave de Tavily, solo en Vercel |
   | `ASSISTANT_DEVICE_TOKEN` | Sí | Token aleatorio, mínimo 24 caracteres |
   | `UPSTASH_REDIS_REST_URL` | Sí | Endpoint REST HTTPS de Redis |
   | `UPSTASH_REDIS_REST_TOKEN` | Sí | Token de escritura de Redis |
   | `SUPABASE_URL` | Sí | URL HTTPS del proyecto Supabase |
   | `SUPABASE_SERVICE_ROLE_KEY` | Sí | Clave secreta de servidor; nunca incluirla en el firmware |
   | `ASSISTANT_FAMILY_MEMBER_ID` | No | Fallback de compatibilidad para firmware antiguo sin `speaker_id`; no representa a toda la familia |
   | `ASSISTANT_DEVICE_ID` | No | UUID de dispositivo para validar `devices.active` y actualizar `last_seen_at` |
   | `GEMINI_MODEL` | No | Por defecto `gemini-3.5-flash-lite` |
   | `ENABLE_TAVILY_SEARCH` | No | Activo por defecto; `false` lo desactiva |
   | `TAVILY_MAX_MONTHLY_CREDITS` | No | Por defecto 900; admite de 1 a 1000 |
   | `TAVILY_SEARCH_DEPTH` | No | `basic` por defecto; también `fast`, `ultra-fast`, `advanced` |
   | `TAVILY_MAX_RESULTS` | No | Por defecto 5; máximo 5 |
   | `MAX_ASSISTANT_REQUESTS_PER_DAY` | No | Por defecto 120; máximo 1000 |

5. Despliega y copia el dominio HTTPS asignado por Vercel.
6. En el sketch, reemplaza el host de ejemplo de
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

La selección manual determina a quién se atribuye el mensaje; el token
autentica el dispositivo, no a la persona. `ASSISTANT_FAMILY_MEMBER_ID` solo
mantiene compatibilidad con solicitudes antiguas sin `speaker_id` y debe
retirarse cuando ya no haya clientes antiguos. `ASSISTANT_DEVICE_ID`, si se
configura, valida el registro activo de `devices`; no vincula el dispositivo
con un integrante. Las tablas tienen RLS habilitado;
verifica las políticas y permisos de la base real con el export vigente antes
del despliegue. El backend usa la clave `service_role`, que nunca se envía al
ESP32 ni se devuelve en respuestas HTTP.

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

## Caché, conversaciones y contexto familiar

Redis conserva resultados de búsqueda, no conversaciones completas. Las claves
se generan con hashes de las consultas y expiran según el tipo detectado:

- Actualidad general: 6 horas.
- Precios: 5 minutos; la búsqueda solicita contenido en vivo a Tavily.
- Deportes/fixture: 30 minutos.
- Información institucional: 24 horas.

Supabase conserva cada intercambio, recupera los tres turnos recientes cuando
el firmware no envía historial, y almacena memorias, preferencias, contexto
emocional, tareas, proyectos y recordatorios. Las nuevas memorias y acciones se
extraen con una llamada estructurada a Gemini después de responder; si falla, la
respuesta conserva su contrato e informa `status: "knowledge_update_error"`.
Las escrituras transaccionales que usan RPC requieren la migración manual
anterior. La extracción solo debe crear tareas o recordatorios solicitados
explícitamente.

El asistente incorpora datos relevantes al contexto de Gemini, sin enviar la
base completa. Las tareas se completan/reabren mediante RPC transaccional, que
registra el cambio y gestiona entregas. Los recordatorios y seguimientos vencidos
se convierten en entregas idempotentes a los cuatro integrantes; el ESP32 los
recupera por polling, con ACK y reintentos. Un dispositivo desconectado no puede
recibir avisos espontáneos.

Vercel Hobby no es un proceso siempre activo. Los límites de Vercel Cron/Schedules
dependen del producto y plan; no se usan como garantía de avisos de 30 segundos.
Supabase Cron (`pg_cron`) puede ejecutar trabajos periódicos en la base, pero
requiere verificar disponibilidad, cuotas y continuidad del proyecto concreto.
Para la configuración inicial sin gasto adicional, el polling iniciado por el
ESP32 es la opción más simple; para avisos fuera de línea se necesita otro canal
push (por ejemplo, WhatsApp en una etapa futura) o un servicio siempre activo.

## Pruebas

Desde esta carpeta:

```powershell
npm test
```

Las pruebas usan respuestas simuladas; no envían preguntas a Gemini o Tavily ni
requieren claves.

La suite actual cubre unitariamente el backend con dobles de prueba. No prueba
una instancia real de Supabase ni llamadas reales a Gemini/Tavily. Esas pruebas
de integración quedan pendientes de credenciales de staging y aprobación; nunca
se deben probar contra producción sin autorización.

Para una prueba manual en Postman:

- `POST https://<tu-proyecto>.vercel.app/api/chat`
- Header `Content-Type: application/json`
- Header `Authorization: Bearer <ASSISTANT_DEVICE_TOKEN>`
- Body raw JSON:

```json
{
  "question": "¿Qué partidos importantes hay este fin de semana?",
  "history": [],
  "speaker_id": "<UUID_DE_UN_INTEGRANTE>"
}
```

Una pregunta general como “¿Qué es un amplificador clase D?” debe contestarse
sin llamar a Tavily. En una consulta actual, la respuesta debe traer
`searched_web: true` y `sources` con títulos y enlaces HTTPS.

El firmware consulta además `GET /api/members`, `GET
/api/notifications/pending?speaker_id=<UUID>` y `POST
/api/notifications/ack`. Todos requieren el mismo Bearer de dispositivo.

## Documentación oficial consultada

- [Gemini Function Calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Modelos Gemini](https://ai.google.dev/gemini-api/docs/models)
- [Precios y nivel gratuito de Gemini API](https://ai.google.dev/gemini-api/docs/pricing)
- [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Tavily Usage API](https://docs.tavily.com/documentation/api-reference/endpoint/usage)
- [Tavily créditos y precios](https://docs.tavily.com/documentation/api-credits)
- [Upstash Redis REST](https://upstash.com/docs/redis/features/restapi)
- [Vercel Functions](https://vercel.com/docs/functions)
- [Vercel Cron: uso y límites](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing)
- [Vercel Schedules: límites](https://vercel.com/docs/schedules/limits)
- [Supabase Cron](https://supabase.com/docs/guides/cron)
- [Planes Supabase](https://supabase.com/pricing)
