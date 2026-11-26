# Backend Gemini/Groq + Tavily para Vercel

Este backend mantiene la conversación con Gemini o Groq, seleccionables por
variables de entorno, y ofrece una herramienta `web_search` para que el modelo
decida cuándo consultar Tavily. Groq usa su endpoint compatible con OpenAI y
Gemini conserva su API nativa. Si el proveedor principal falla por conexión,
capacidad, límite de solicitudes o incompatibilidad, Robert intenta el otro
proveedor configurado como respaldo. Conserva el
contrato anterior del firmware (`question`, `history`, `answer`, `searched_web`,
`sources`, `status`) y acepta campos opcionales `speaker_id` y
`conversation_id`. El selector del ESP32 envía `speaker_id`; el ID se valida
contra los cuatro integrantes activos en cada solicitud.

El modelo Groq predeterminado es `openai/gpt-oss-120b`; el modelo Gemini
predeterminado sigue siendo `gemini-3.5-flash-lite`. Ambos proveedores pueden
usar la herramienta local `web_search`; la búsqueda se ejecuta en Tavily, no
mediante Google Search Grounding.

## Arquitectura

- `server.mjs`: punto de entrada local existente; atiende `/health`, `/chat`, `/api/chat` y `/api/weather`.
- `api/chat.mjs`: función Vercel en `POST /api/chat`, usando el mismo handler.
- `api/weather.mjs`: `POST /api/weather`, consulta autenticada de clima actual y pronóstico mediante Open-Meteo; no llama a Gemini, Tavily ni a la persistencia familiar.
- `api/members.mjs`: `GET /api/members`, roster para el selector manual.
- `api/notifications/`: consulta autenticada y ACK de entregas.
- `api/conversations.mjs`, `api/conversations/messages.mjs`, `api/tasks.mjs`, `api/reminders.mjs` y `api/agenda.mjs`: endpoints de solo lectura para la PWA, autenticados con token de dispositivo o sesión móvil. No modifican datos ni llaman a Gemini/Tavily.
- `api/family-messages.mjs` y `lib/family_messages_api.mjs`: mensajería familiar autenticada solo con sesión móvil firmada; el remitente se toma de esa sesión.
- `lib/read_api.mjs`: controlador de los endpoints de lectura; `/api/agenda` combina tareas abiertas, recordatorios próximos, cumpleaños y, si se envían coordenadas, un resumen de Open-Meteo.
- `lib/assistant.mjs`: autenticación, contexto, selección de búsqueda, límites, síntesis y coordinación familiar.
- `lib/weather_controller.mjs` y `services/weather_*.mjs`: endpoint autenticado, intención, geocoding Open-Meteo, pronóstico y caché en memoria de 30 minutos.
- `tools/web_search.js`: cliente HTTPS de Tavily Search y Usage.
- `lib/redis_store.mjs`: contadores, reserva atómica, bloqueo de duplicados y caché en Upstash Redis.
- `database/` y `services/`: persistencia Supabase y gestión de familia, conversaciones, memoria, tareas, recordatorios y contexto proactivo.
- `services/family_messages.service.mjs` y `services/family_message_intent.mjs`: persistencia e interpretación determinística de mensajes; estas órdenes no pasan por la extracción de memoria.

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

La migración complementaria `database/migrations/20261124_family_messages.sql`
usa las tablas `family_messages` y `family_message_reads` ya existentes. Añade
una clave opcional de idempotencia, reemplaza el cuerpo de la función existente
`create_family_message_reads()` sin duplicar el trigger y completa recibos
faltantes de mensajes anteriores. La función también rechaza remitentes o
destinatarios inactivos en la base. Ejecútala manualmente en Supabase antes de
habilitar la función. No crea, elimina ni recrea tablas o triggers.

El ESP32 consulta `/api/notifications/pending` cada 30 segundos mientras está
conectado y en reposo. La base detecta vencimientos al atender ese polling,
aplica quiet hours y límites diarios y mantiene entregas individuales para los
cuatro integrantes. No es push: si el ESP32 está apagado o sin conexión, el
aviso se muestra cuando vuelva a consultar. Un solo ESP32 solo puede mostrar el
aviso del integrante seleccionado.

## Google Calendar y Google Tasks con Composio

El chat detecta pedidos como "decime qué tengo agendado para hoy" y consulta
Google Calendar a través de Composio antes de responder y crea eventos cuando
el usuario pide “Agenda…” con fecha y hora concretas. Las tareas se consultan y administran en Google Tasks: las
tablas locales `tasks` y `task_history` ya no son la fuente de tareas del
asistente. Resuelve la conexión según el integrante seleccionado y el proveedor.

| Variable | Requerida | Valor/uso |
| --- | --- | --- |
| `COMPOSIO_API_KEY` | Para Calendar y Tasks | Clave de proyecto de Composio; solo en el backend |
| `COMPOSIO_GOOGLE_CALENDAR_ID` | No | Calendario por defecto si la fila no define uno; `primary` |

Ejecuta `database/migrations/20261126_family_member_integrations.sql` en
Supabase. Luego ejecuta `database/migrations/20261127_google_tasks_provider.sql`
para habilitar el proveedor `google_tasks`. Registra una fila por integrante y
proveedor en `family_assistant.family_member_integrations`, con su
`family_member_id`, `composio_user_id` y `connected_account_id` (`ca_...`) de la
misma conexión. La API key se comparte; los IDs de Calendar y Tasks son cuentas
separadas. Google Tasks usa el alcance `https://www.googleapis.com/auth/tasks`
para leer y modificar tareas.

La cuenta conectada necesita el alcance
`https://www.googleapis.com/auth/calendar.events` para crear eventos (y leerlos).
Si fue conectada con solo `calendar.events.readonly`, actualiza el alcance OAuth
en Composio y vuelve a conectar la cuenta para conceder permiso de escritura.
Los eventos “Agenda…” con fecha y hora explícitas se guardan en el Google Calendar
personal del integrante; la duración es una hora por defecto y respeta la duración
indicada. “Recordame…”, “Anota…” y recordatorios recurrentes se guardan en la tabla
familiar `reminders`; un reminder sin fecha recibe mañana a las 09:00 como próxima
notificación. Si una integración no está configurada, el asistente registra el
error en el backend. Calendar usa `GOOGLECALENDAR_EVENTS_LIST` y
`GOOGLECALENDAR_CREATE_EVENT`; las tareas usan `GOOGLETASKS_LIST_TASKS`,
`GOOGLETASKS_INSERT_TASK` y `GOOGLETASKS_PATCH_TASK`. Sus resultados no se
persisten en las tablas `tasks` ni `task_history`.

## Desplegar en Vercel Hobby

1. Usa el proyecto Supabase existente. Confirma que el esquema
   `family_assistant` tenga sus 20 tablas, exactamente cuatro integrantes
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
   | `AI_PROVIDER` | No | `groq` o `gemini`. Si se omite, usa Groq cuando existe `GROQ_API_KEY`; si no, usa Gemini |
   | `AI_FALLBACK_PROVIDER` | No | `gemini`, `groq` o `none`. Si se omite y están configuradas ambas claves, usa el otro proveedor como respaldo |
   | `GROQ_API_KEY` | Si se usa Groq | Clave de Groq, solo en Vercel |
   | `GROQ_MODEL` | No | Por defecto `openai/gpt-oss-120b`; también se puede configurar `qwen/qwen3.8-27b` |
   | `GEMINI_API_KEY` | Si se usa Gemini | Clave de Gemini, solo en Vercel; necesaria también para usarlo como respaldo |
   | `GEMINI_MODEL` | No | Por defecto `gemini-3.5-flash-lite` |
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
   | `ASSISTANT_MOBILE_PASSCODE` | Para móvil | Código familiar aleatorio de al menos 24 caracteres; solo en Vercel |
   | `ASSISTANT_MOBILE_SESSION_SECRET` | Para móvil | Secreto de firma aleatorio de al menos 32 bytes; solo en Vercel |
   | `ASSISTANT_MOBILE_ORIGINS` | Para móvil | Orígenes HTTPS de la PWA separados por comas, sin rutas |
   | `WEATHER_DEFAULT_LOCATION` | No | Localidad para fallback cuando la geolocalización no está disponible; por defecto `Buenos Aires, Argentina` |
   | `GEONAMES_USERNAME` | Para clima | Usuario GeoNames configurado solo en el backend; se usa para resolver localidades de Argentina |
   | `COMPOSIO_API_KEY` | Para calendario | Clave de proyecto de Composio; solo en el backend |
   | `COMPOSIO_GOOGLE_CALENDAR_ID` | No | Calendario a consultar; por defecto `primary` |

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
- `POST https://<tu-proyecto>.vercel.app/api/weather`
- Header `Content-Type: application/json`
- Header `Authorization: Bearer <ASSISTANT_DEVICE_TOKEN>`
- Para `/api/chat`, body raw JSON:

```json
{
  "question": "¿Qué partidos importantes hay este fin de semana?",
  "history": [],
  "speaker_id": "<UUID_DE_UN_INTEGRANTE>"
}
```

Para `/api/weather`, se envía la pregunta y, si el usuario autorizó la
geolocalización, `current_location` con latitud/longitud. Ese objeto se usa solo
para esa consulta; el endpoint no guarda conversaciones ni memorias.

```json
{
  "question": "¿Va a llover mañana?",
  "current_location": { "latitude": -34.6, "longitude": -58.4 }
}
```

Una pregunta general como “¿Qué es un amplificador clase D?” debe contestarse
sin llamar a Tavily. En una consulta actual, la respuesta debe traer
`searched_web: true` y `sources` con títulos y enlaces HTTPS.

El firmware consulta además `GET /api/members`, `GET
/api/notifications/pending?speaker_id=<UUID>` y `POST
/api/notifications/ack`. Todos requieren el mismo Bearer de dispositivo.

## Endpoints de lectura de la PWA

Todos son `GET`, aceptan el Bearer de dispositivo o una sesión móvil firmada, y
responden con `cache-control: no-store`. Con token de dispositivo hay que enviar
`speaker_id`; con sesión móvil el integrante queda fijado por la sesión.

| Endpoint | Contenido |
| --- | --- |
| `GET /api/conversations?limit=20` | Conversaciones recientes del integrante. |
| `GET /api/conversations/messages?conversation_id=<UUID>&limit=50` | Mensajes de una conversación propia. |
| `GET /api/tasks?status=open\|all&limit=20` | Tareas de la familia; `open` es el valor por defecto. |
| `GET /api/reminders?hours=24&limit=10` | Recordatorios pendientes en la ventana indicada. |
| `GET /api/agenda?latitude=&longitude=` | Tareas abiertas, recordatorios próximos, cumpleaños y clima opcional. |
| `GET /api/family-messages?limit=50&offset=0` | Historial familiar, integrantes activos y cantidad sin leer. Requiere sesión móvil. |
| `GET /api/family-messages?unread_only=true` | Mensajes pendientes para el integrante autenticado. |
| `GET /api/family-messages?message_id=<UUID>` | Estado de lectura individual por integrante. |
| `POST /api/family-messages` | Envía `{content, recipient_id, request_id}`; `recipient_id: null` significa toda la familia. |
| `POST /api/family-messages` con `{action:"read", message_id}` | Marca como leído solo para el integrante autenticado. |

Los recordatorios creados desde el chat requieren que el mensaje empiece con
`Agenda`. Por ejemplo, `Agenda que todos los miércoles hay descuento en
empanadas en La Reina` crea una ocurrencia semanal. `scheduled_at` guarda la
próxima fecha y hora de aviso; `recurrence_rule` indica `weekly` y
`recurrence_timezone` conserva la zona horaria familiar. Al entregarse a todos
los integrantes, la próxima fecha avanza siete días de calendario y el estado
del recordatorio sigue en `pending`. Cuando la promoción termina, se puede
decirlo claramente para cancelar la repetición.

Antes de desplegar este comportamiento, aplicar la migración
`database/migrations/20261125_recurring_reminders.sql` en Supabase.

`/api/agenda` solo consulta Open-Meteo cuando recibe `latitude` y `longitude`
válidas; si faltan o son inválidas, devuelve `weather: null` sin llamar al
proveedor. Estos endpoints no escriben en Supabase ni Redis.

Las rutas de mensajería son la excepción de escritura y aceptan únicamente la
sesión móvil firmada; el endpoint de chat también interpreta órdenes de mensaje
por voz o texto en la PWA. Todos los mensajes quedan visibles para integrantes
activos y el destinatario se destaca como prioritario. La PWA actualiza la
campanita por polling cada 30 segundos mientras está visible; no requiere push
y un integrante desconectado verá los mensajes al volver. No se habilitó
Realtime desde el navegador porque las políticas RLS actuales no dan acceso
directo a las tablas; el backend conserva el acceso con `service_role`.
El esquema confirmado no tiene `family_id` y el backend actual representa una
sola familia; para alojar varias familias en la misma base habrá que incorporar
esa clave y aplicar el aislamiento correspondiente antes de habilitarlo.

## Acceso de la PWA móvil

La app de `../appmobile` no contiene el token del dispositivo ni credenciales
del proveedor. En Vercel configura un código familiar aleatorio
(`ASSISTANT_MOBILE_PASSCODE`, mínimo 24 caracteres) y una clave de firma
(`ASSISTANT_MOBILE_SESSION_SECRET`, mínimo 32 bytes). Genera valores con:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Configura `ASSISTANT_MOBILE_ORIGINS` con el origen exacto de la PWA, por ejemplo
`https://mi-asistente.vercel.app` (sin `/` final ni rutas). El desarrollo local
permite `http://localhost:5173` y `http://127.0.0.1:5173`.

`POST /api/mobile/session` valida el código y devuelve los integrantes activos;
al recibir también `speaker_id`, entrega una sesión firmada por siete días,
vinculada a ese integrante. La app la envía como Bearer a `POST /api/chat`.
La sesión expira y entonces se vuelve a pedir el código. Nunca copies el código,
la clave de firma, el token del dispositivo o claves de Gemini/Tavily al bundle
de Vite.

Las conversaciones móviles reutilizan el endpoint, el contexto, las memorias y
las tablas existentes. No se agrega un esquema ni tablas nuevas. El valor
histórico de canal de conversaciones existentes permanece intacto; las nuevas
conversaciones registran `pwa` o `esp32` según el tipo de sesión.

## Continuidad conversacional y contexto familiar

`POST /api/chat` recupera hasta ocho pares usuario/asistente de la conversación
identificada por `conversation_id`, valida que pertenezca al integrante activo y
los envía a Gemini en orden cronológico. Si un cliente inicia sin ID, Robert
retoma la conversación abierta más reciente de ese mismo integrante; nunca
mezcla mensajes de dos IDs. Esto permite que un cliente que arranca de cero
retome la conversación familiar activa. La PWA conserva su ID en almacenamiento
local y el ESP32 conserva el suyo mientras está encendido.

La recuperación de `memories` usa relevancia textual, confianza mínima de 0.65
y descarta recuerdos cuyo `valid_until` haya pasado. Las preguntas de
cumpleaños recuperan todos los cumpleaños activos y confiables. La política
actual solicitada es que cualquier integrante pueda consultar las memorias de
cualquier otro; preferencias y contexto emocional continúan limitados al
integrante seleccionado. Tareas, proyectos, recordatorios, preferencias y
contexto emocional se agregan al prompt solo cuando la pregunta o el seguimiento
trata de esos temas. No hubo cambios de esquema ni migraciones de Supabase.

Las llamadas de conversación, síntesis web y extracción usan el proveedor
seleccionado por `AI_PROVIDER` y sus modelos `GROQ_MODEL`/`GEMINI_MODEL`. El
respaldo se usa ante errores del proveedor principal y mantiene el
mismo contrato interno. La generación conversacional usa temperature 0.75,
topP 0.9 y 1024 tokens; la extracción estructurada mantiene temperature 0 y
1024 tokens. Con Groq, la extracción familiar usa JSON Schema estricto y
reduce el esfuerzo de razonamiento de GPT-OSS; si el proveedor principal falla,
Gemini tiene hasta 20 segundos para completar esa tarea en segundo plano.
El endpoint guarda cada turno en Supabase antes de responder. En Vercel, la
extracción y persistencia de memorias/tareas se agenda con `waitUntil` para que
no demore la respuesta; la función tiene `maxDuration = 60`. `waitUntil` mantiene
el trabajo durante el ciclo de vida de la función, pero no lo puede completar si
la función llega al límite de duración. En desarrollo local, sin scheduler de
Vercel, las actualizaciones familiares se esperan antes de responder.

La PWA muestra la respuesta original y prepara una versión hablada con fechas,
unidades y enlaces normalizados. La lectura empieza por fragmentos cuando la
respuesta completa llega del backend; no hay streaming de texto del modelo. El
reconocimiento de voz no se modificó.

## Documentación oficial consultada

- [Groq Chat Completions API](https://console.groq.com/docs/api-reference)
- [Groq uso de herramientas](https://console.groq.com/docs/tool-use/overview)
- [Groq salidas estructuradas](https://console.groq.com/docs/structured-outputs)
- [Groq razonamiento y parámetros](https://console.groq.com/docs/reasoning)
- [Groq modelos y capacidades](https://console.groq.com/docs/models)
- [Groq límites y encabezados de cuota](https://console.groq.com/docs/rate-limits)
- [Gemini Function Calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Modelos Gemini](https://ai.google.dev/gemini-api/docs/models)
- [Precios y nivel gratuito de Gemini API](https://ai.google.dev/gemini-api/docs/pricing)
- [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Tavily Usage API](https://docs.tavily.com/documentation/api-reference/endpoint/usage)
- [Tavily créditos y precios](https://docs.tavily.com/documentation/api-credits)
- [Upstash Redis REST](https://upstash.com/docs/redis/features/restapi)
- [Vercel Functions](https://vercel.com/docs/functions)
- [Vercel `waitUntil`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)
- [Vercel Cron: uso y límites](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing)
- [Vercel Schedules: límites](https://vercel.com/docs/schedules/limits)
- [Supabase Cron](https://supabase.com/docs/guides/cron)
- [Planes Supabase](https://supabase.com/pricing)
