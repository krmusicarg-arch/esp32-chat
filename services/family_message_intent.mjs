const normalize = (value) => String(value || "")
  .toLocaleLowerCase("es-AR")
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
  .replace(/\s+/g, " ")
  .trim();

const SEND_PATTERN = /^(?:por favor\s+)?(?:mand(?:a|á)(?:le|les)?(?:\s+un mensaje)?|envi(?:a|á)(?:me)?\s+un mensaje|avis(?:a|á)(?:le|les)?|dec(?:i|í)(?:le|les)?)\s+(?:a\s+)?(.+?)\s+(?:que|:)\s*(.+)$/iu;

function namedMembers(target, members) {
  const normalizedTarget = normalize(target);
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
  const original = String(question || "").trim().replace(/^(?:robert(?:ito)?)[,\s]+/iu, "");
  const normalized = normalize(original);
  const match = original.match(SEND_PATTERN);
  if (match) {
    const target = match[1].trim().replace(/[?.!,]+$/u, "");
    const content = match[2].trim();
    if (!content) return { type: "clarify", answer: "¿Qué mensaje querés enviar?" };
    if (/^(?:(?:para|a)\s+)?(?:todos|todas|todo el mundo|toda la familia|la familia)$/iu.test(target)) {
      return { type: "send", recipientId: null, recipientName: null, content };
    }
    const recipients = namedMembers(target, members);
    if (recipients.length === 1) {
      return { type: "send", recipientId: recipients[0].id, recipientName: recipients[0].name, content };
    }
    if (recipients.length > 1) {
      return { type: "clarify", answer: `Hay más de un integrante llamado ${target}. Decime el apellido o cómo distinguirlo. No envié el mensaje.` };
    }
    return { type: "clarify", answer: `No encuentro a ${target} entre los integrantes activos. No envié el mensaje.` };
  }

  if (/\b(?:tengo mensajes|mensajes (?:hay )?pendientes|mensajes sin leer|que mensajes recibi|mensajes recibidos)\b/u.test(normalized)) return { type: "unread" };
  if (/\b(?:quien leyo|ley[oó] el mensaje|ley[oó] mi mensaje|ley[oó] el mensaje que mande)\b/u.test(normalized)) return { type: "read_status" };
  if (/\b(?:ultimos mensajes|mensajes de la familia|mostrame los mensajes|que mensajes hay)\b/u.test(normalized)) return { type: "list" };
  if (/\b(?:mandale|mandales|manda un mensaje|envia un mensaje|avisale|avisales|decile|deciles)\b/u.test(normalized)) {
    return { type: "clarify", answer: "No pude identificar con seguridad a quién va dirigido el mensaje. No lo envié." };
  }
  return null;
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
