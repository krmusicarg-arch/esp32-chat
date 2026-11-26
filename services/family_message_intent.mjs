const normalize = (value) => String(value || "")
  .toLocaleLowerCase("es-AR")
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
  .replace(/\s+/g, " ")
  .trim();

function cleanTarget(target) {
  return String(target || "")
    .trim()
    .replace(/^[,\s¿¡]+|[,\s?!.]+$/gu, "")
    // Some voice transcripts place the object phrase inside the captured target,
    // e.g. "Enviale el mensaje a Karina que ...".
    .replace(/^(?:(?:un|el|este|ese)\s+)?(?:mensaje|aviso)\s+(?:a|para)\s+/iu, "")
    .replace(/^(?:a\s+|para\s+)?(?:(?:la|el|al|los|las|mi|mis)\s+)?/iu, "")
    .replace(/\s+(?:un\s+)?(?:mensaje|aviso|nota)$/iu, "")
    .replace(/[?.!,]+$/u, "")
    .trim();
}

function cleanContent(content) {
  return String(content || "")
    .trim()
    .replace(/^[,\s¿¡:.]+/gu, "")
    .replace(/^(?:que|para que|de que)\s+/iu, "")
    .replace(/[,\s?!.]+$/gu, "")
    .trim();
}

const SEND_PATTERN = /^(?:(?:hola|buenas|buen d[ií]a|buenas tardes|buenas noches|che|hey)\s+)?(?:(?:robert(?:ito)?)\s*)?[,\s:]*(?:(?:por favor|porfa|quiero(?: que)?|quisiera(?: que)?|necesito(?: que)?|pod[eé]s?|puedes|podr[ií]as?|me pod[eé]s|me puedes|me podr[ií]as?)\s+)*(?:(?:le|les)\s+)?(?:mand(?:a|á|ás|e|es|en|ar)|envi(?:a|á|ás|e|es|ar)|avis(?:a|á|ás|e|es|ar)|dec(?:i|í|ís|ir)|dig(?:a|as))(?:le|les)?(?:\s+(?:(?:un|el|este|ese)\s+)?(?:mensaje|aviso))?\s+(?:(?:a|para)\s+)?(.+?)(?:\s+(?:un\s+)?(?:mensaje|aviso))?(?:\s*(?:[,.:;]|\s+(?:para\s+que|de\s+que|que|dici[eé]ndo(?:le|les)?(?:\s+que)?|avis[aá]ndo(?:le|les)?(?:\s+que)?|si\s+puede|si)\b)\s*|\s*:\s*)\s*(.+)$/iu;
const SEND_WITHOUT_CONTENT_PATTERN = /^(?:(?:hola|buenas|buen d[ií]a|buenas tardes|buenas noches|che|hey)\s+)?(?:(?:robert(?:ito)?)\s*)?[,\s:]*(?:(?:por favor|porfa|quiero(?: que)?|quisiera(?: que)?|necesito(?: que)?|pod[eé]s?|puedes|podr[ií]as?|me pod[eé]s|me puedes|me podr[ií]as?)\s+)*(?:(?:le|les)\s+)?(?:mand(?:a|á|ás|e|es|en|ar)|envi(?:a|á|ás|e|es|ar)|avis(?:a|á|ás|e|es|ar)|dec(?:i|í|ís|ir)|dig(?:a|as))(?:le|les)?\s+(?:(?:(?:un|el|este|ese)\s+)?(?:mensaje|aviso)\s+)?(?:(?:a|para)\s+)?(.+?)\s*$/iu;

function namedMembers(target, members) {
  const normalizedTarget = normalize(cleanTarget(target));
  const targetTokens = normalizedTarget.split(" ").filter(Boolean);
  return members.filter((member) => {
    const name = normalize(member.name);
    const nameTokens = name.split(" ").filter(Boolean);
    if (targetTokens.length > 1) {
      return targetTokens.length === nameTokens.length
        && targetTokens.every((token) => nameTokens.includes(token));
    }
    return nameTokens.some((token) => token === normalizedTarget
      || (normalizedTarget.length >= 3 && token.startsWith(normalizedTarget)));
  });
}

export function detectFamilyMessageIntent(question, members = []) {
  const original = String(question || "").trim()
    .replace(/^[,\s¿¡]+|[,\s?!.]+$/gu, "");
  const normalized = normalize(original);
  const match = original.match(SEND_PATTERN);
  if (match) {
    const rawTarget = match[1].trim().replace(/[?.!,]+$/u, "");
    const target = cleanTarget(rawTarget);
    const rawContent = match[2].trim();
    const content = cleanContent(rawContent) || rawContent;
    if (!content) return { type: "clarify", answer: "Dale, ¿qué querés que le diga?" };
    if (/^(?:(?:para|a)\s+)?(?:todos|todas|todo el mundo|toda la familia|la familia|el grupo)$/iu.test(rawTarget)
        || /^(?:todos|todas|todo el mundo|toda la familia|la familia|el grupo)$/iu.test(target)) {
      return { type: "send", recipientId: null, recipientName: null, content };
    }
    const recipients = namedMembers(rawTarget, members);
    if (recipients.length === 1) {
      return { type: "send", recipientId: recipients[0].id, recipientName: recipients[0].name, content };
    }
    if (recipients.length > 1) {
      return { type: "clarify", answer: `Hay más de un integrante llamado ${target || rawTarget}. ¿A cuál te referís? Todavía no envié el mensaje.` };
    }
    return { type: "clarify", answer: `No encuentro a ${rawTarget} entre los integrantes activos. ¿A quién te referís? Todavía no envié el mensaje.` };
  }

  const incompleteSend = original.match(SEND_WITHOUT_CONTENT_PATTERN);
  if (incompleteSend) {
    const rawTarget = incompleteSend[1].trim().replace(/[?.!,]+$/u, "");
    const target = cleanTarget(rawTarget);
    const recipients = namedMembers(rawTarget, members);
    if (recipients.length === 1) {
      return { type: "clarify", answer: `Claro, ¿qué querés que le diga a ${recipients[0].name}?` };
    }
    if (recipients.length > 1) {
      return { type: "clarify", answer: `Hay más de un integrante llamado ${target || rawTarget}. ¿A cuál te referís? Todavía no envié el mensaje.` };
    }
    return { type: "clarify", answer: `No encuentro a ${rawTarget} entre los integrantes activos. ¿A quién te referís? Todavía no envié el mensaje.` };
  }

  if (/\b(?:tengo mensajes|mensajes (?:hay )?pendientes|mensajes sin leer|que mensajes recibi|mensajes recibidos)\b/u.test(normalized)) return { type: "unread" };
  if (/\b(?:quien leyo|ley[oó] el mensaje|ley[oó] mi mensaje|ley[oó] el mensaje que mande)\b/u.test(normalized)) return { type: "read_status" };
  if (/\b(?:ultimos mensajes|mensajes de la familia|mostrame los mensajes|que mensajes hay)\b/u.test(normalized)) return { type: "list" };
  if (/\b(?:mand(?:ale|ales|ar(?:le|les)?|a|as|en)|envi(?:a(?:le|les)?|ar(?:le|les)?|e(?:le|les)?)|avis(?:a(?:le|les)?|ar(?:le|les)?|e(?:le|les)?)|dec(?:i(?:le|les)?|ir(?:le|les)?)|dig(?:a|as))\b/u.test(normalized)) {
    return { type: "clarify", answer: "Quiero asegurarme de mandarlo a la persona correcta. ¿A quién se lo envío?" };
  }
  return null;
}

export function shouldInterpretFamilyMessage(question, members = []) {
  const original = String(question || "").trim();
  const normalized = normalize(original);
  const hasMessageAction = /\b(?:decir|decile|deciles|dile|diles|avisar|avisale|avisales|contar|contale|contales|escribir|escribile|escribiles|mandar|mandale|mandales|enviar|enviale|enviales|comentar|comentale|comentales|preguntar|preguntale|preguntales|hacerle llegar|hacerles llegar|hacerle saber|hac[eé]le llegar|mensajear|sepa|sepas|sepan|reciba|recibas|reciban)\b/u.test(normalized);
  if (!hasMessageAction) return false;

  const normalizedNames = members.flatMap((member) => normalize(member.name).split(" "))
    .filter((token) => token.length >= 3);
  const questionTokens = new Set(normalized.split(" "));
  const mentionsMember = normalizedNames.some((name) => questionTokens.has(name));
  const mentionsFamily = /\b(?:todos|todas|familia|grupo)\b/u.test(normalized);
  const hasRecipientShape = /\b(?:a|para|con)\s+\p{Letter}/u.test(normalized)
    || /\b(?:le|les)\s+\p{Letter}/u.test(normalized);
  return mentionsMember || mentionsFamily || hasRecipientShape;
}

export function findMentionedMember(question, members = []) {
  const normalized = normalize(question);
  const questionTokens = new Set(normalized.split(" "));
  const matches = members.filter((member) => {
    const name = normalize(member.name);
    const nameTokens = name.split(" ").filter((token) => token.length >= 3);
    return name && (normalized.includes(name) || nameTokens.some((token) => questionTokens.has(token)));
  });
  return matches.length === 1 ? matches[0] : null;
}
