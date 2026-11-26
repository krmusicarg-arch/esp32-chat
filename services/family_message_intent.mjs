const normalize = (value) => String(value || "")
  .toLocaleLowerCase("es-AR")
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
  .replace(/\s+/g, " ")
  .trim();

export const phoneticNormalize = (value) => {
  let s = normalize(value);
  if (!s) return "";
  s = s.replace(/h/g, "");
  s = s.replace(/v/g, "b");
  s = s.replace(/qu/g, "k");
  s = s.replace(/c(?=[ei])/g, "s");
  s = s.replace(/c/g, "k");
  s = s.replace(/z/g, "s");
  s = s.replace(/ll/g, "y");
  s = s.replace(/([a-z])\1+/g, "$1");
  return s;
};

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

function foldAccentsWithMap(value) {
  const text = String(value || "");
  let folded = "";
  const map = [];
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    const plain = char.normalize("NFD").replace(/\p{Diacritic}/gu, "");
    for (let offset = 0; offset < plain.length; offset += 1) map.push(index);
    folded += plain;
    index += char.length;
  }
  return { folded, map, length: text.length };
}

// Voice transcripts usually include written accents ("Avísale", "Mándale"),
// while the command patterns are written without them. Match unaccented first
// so accented content is preserved, then retry with a folded copy and map the
// captured groups back onto the original text.
export function matchFamilyCommand(pattern, value) {
  const text = String(value || "");
  const direct = text.match(pattern);
  if (direct) {
    return { groups: direct.slice(1).map((group) => group ?? ""), original: text };
  }
  const { folded, map } = foldAccentsWithMap(text);
  if (!folded || folded === text) return null;
  const flags = pattern.flags.includes("d") ? pattern.flags : `${pattern.flags}d`;
  const match = new RegExp(pattern.source, flags).exec(folded);
  if (!match) return null;
  const groups = [];
  for (let groupIndex = 1; groupIndex < match.length; groupIndex += 1) {
    const indices = match.indices?.[groupIndex];
    if (!indices) {
      groups.push("");
      continue;
    }
    const [start, end] = indices;
    const originalStart = start < map.length ? map[start] : text.length;
    const originalEnd = end < map.length ? map[end] : text.length;
    groups.push(text.slice(originalStart, originalEnd));
  }
  return { groups, original: text };
}

export function namedMembers(target, members) {
  const cleaned = cleanTarget(target);
  const normalizedTarget = normalize(cleaned);
  const targetTokens = normalizedTarget.split(" ").filter(Boolean);
  const exact = members.filter((member) => {
    const name = normalize(member.name);
    const nameTokens = name.split(" ").filter(Boolean);
    if (targetTokens.length > 1) {
      return targetTokens.length === nameTokens.length
        && targetTokens.every((token) => nameTokens.includes(token));
    }
    return nameTokens.some((token) => token === normalizedTarget
      || (normalizedTarget.length >= 3 && token.startsWith(normalizedTarget)));
  });
  if (exact.length > 0) return exact;

  const phoneticTarget = phoneticNormalize(cleaned);
  const phoneticTargetTokens = phoneticTarget.split(" ").filter(Boolean);
  return members.filter((member) => {
    const name = phoneticNormalize(member.name);
    const nameTokens = name.split(" ").filter(Boolean);
    if (phoneticTargetTokens.length > 1) {
      return phoneticTargetTokens.length === nameTokens.length
        && phoneticTargetTokens.every((token) => nameTokens.includes(token));
    }
    return nameTokens.some((token) => token === phoneticTarget
      || (phoneticTarget.length >= 3 && token.startsWith(phoneticTarget)));
  });
}

export function detectFamilyMessageIntent(question, members = []) {
  const original = String(question || "").trim()
    .replace(/^[,\s¿¡]+|[,\s?!.]+$/gu, "");
  const normalized = normalize(original);
  const match = matchFamilyCommand(SEND_PATTERN, original);
  if (match) {
    const rawTarget = match.groups[0].trim().replace(/[?.!,]+$/u, "");
    const target = cleanTarget(rawTarget);
    const rawContent = match.groups[1].trim();
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

  const incompleteSend = matchFamilyCommand(SEND_WITHOUT_CONTENT_PATTERN, original);
  if (incompleteSend) {
    const rawTarget = incompleteSend.groups[0].trim().replace(/[?.!,]+$/u, "");
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

export function resolveFollowUpMessageIntent(currentQuestion, history = [], members = []) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const lastTurn = history[history.length - 1];
  if (!lastTurn?.answer || !lastTurn?.question) return null;

  const current = String(currentQuestion || "").trim();

  // Caso A: El asistente preguntó a qué integrante referirse tras no hallar el destinatario o ser ambiguo
  if (/\b(?:a qui[eé]n te refer[ií]s|a qui[eé]n quer[eé]s que se lo env[ií]e|a qui[eé]n se lo env[ií]o|a cu[aá]l te refer[ií]s)\b/iu.test(lastTurn.answer)) {
    const rawTarget = current.replace(/^[,\s¿¡:.]+/gu, "").replace(/[,\s?!.]+$/gu, "");
    const recipients = namedMembers(rawTarget, members);
    if (recipients.length === 1) {
      const match = matchFamilyCommand(SEND_PATTERN, lastTurn.question);
      let content = match ? (cleanContent(match.groups[1].trim()) || match.groups[1].trim()) : "";
      if (!content) {
        const fallbackMatch = lastTurn.question.match(/(?:que|para que|de que|dici[eé]ndole que|avis[aá]ndole que)\s+(.+)$/iu);
        if (fallbackMatch) content = cleanContent(fallbackMatch[1].trim());
      }
      if (content) {
        return {
          type: "send",
          recipientId: recipients[0].id,
          recipientName: recipients[0].name,
          content,
        };
      }
    }
  }

  // Caso B: El asistente preguntó qué mensaje decirle al integrante
  const contentPrompt = lastTurn.answer.match(/(?:qu[eé] quer[eé]s que le diga|qu[eé] mensaje quer[eé]s enviarle)\s+(?:a\s+)?(.+?)\s*\?/iu);
  if (contentPrompt) {
    const target = cleanTarget(contentPrompt[1].trim());
    const recipients = namedMembers(target, members);
    if (recipients.length === 1) {
      const content = cleanContent(current) || current;
      if (content) {
        return {
          type: "send",
          recipientId: recipients[0].id,
          recipientName: recipients[0].name,
          content,
        };
      }
    }
  }

  return null;
}

export function shouldInterpretFamilyMessage(question, members = []) {
  const original = String(question || "").trim();
  const normalized = normalize(original);
  const hasMessageAction = /\b(?:decir|decile|deciles|dile|diles|avisar|avisale|avisales|contar|contale|contales|escribir|escribile|escribiles|mandar|mandale|mandales|enviar|enviale|enviales|comentar|comentale|comentales|preguntar|preguntale|preguntales|hacerle llegar|hacerles llegar|hacerle saber|hac[eé]le llegar|mensajear|sepa|sepas|sepan|reciba|recibas|reciban)\b/u.test(normalized);
  if (!hasMessageAction) return false;

  const normalizedNames = members.flatMap((member) => [
    ...normalize(member.name).split(" "),
    ...phoneticNormalize(member.name).split(" "),
  ]).filter((token) => token.length >= 3);

  const questionTokens = new Set([
    ...normalized.split(" "),
    ...phoneticNormalize(original).split(" "),
  ]);

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
  if (matches.length === 1) return matches[0];

  const phonetic = phoneticNormalize(question);
  const phoneticTokens = new Set(phonetic.split(" "));
  const phoneticMatches = members.filter((member) => {
    const name = phoneticNormalize(member.name);
    const nameTokens = name.split(" ").filter((token) => token.length >= 3);
    return name && (phonetic.includes(name) || nameTokens.some((token) => phoneticTokens.has(token)));
  });
  return phoneticMatches.length === 1 ? phoneticMatches[0] : null;
}
