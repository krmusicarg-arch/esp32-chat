import assert from "node:assert/strict";
import test from "node:test";
import { detectFamilyMessageIntent, findMentionedMember } from "./services/family_message_intent.mjs";

const members = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Ana Ruiz" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Gustavo Pérez" },
  { id: "33333333-3333-4333-8333-333333333333", name: "María López" },
  { id: "44444444-4444-4444-8444-444444444444", name: "Gustavo Sosa" },
];

test("detects a direct message while preserving its content", () => {
  assert.deepEqual(detectFamilyMessageIntent(
    "Robert, avisale a María López que mañana paso a buscarla",
    members,
  ), {
    type: "send",
    recipientId: members[2].id,
    recipientName: "María López",
    content: "mañana paso a buscarla",
  });
});

test("matches a given name that follows the surname in the family roster", () => {
  const surnameFirst = [{ id: "55555555-5555-4555-8555-555555555555", name: "Ontivero Karina" }];
  const intent = detectFamilyMessageIntent("Avisale a Karina que prepare la comida esta noche", surnameFirst);
  assert.equal(intent.type, "send");
  assert.equal(intent.recipientId, surnameFirst[0].id);
  assert.equal(intent.recipientName, "Ontivero Karina");
  assert.equal(intent.content, "prepare la comida esta noche");
  assert.equal(detectFamilyMessageIntent("Avisale a Karina Ontivero que prepare la comida esta noche", surnameFirst).recipientId, surnameFirst[0].id);
});

test("recognizes natural voice command variants and transcribed punctuation", () => {
  const karina = [{ id: "55555555-5555-4555-8555-555555555555", name: "Ontivero Karina" }];
  for (const phrase of [
    "Robertito, avisale a Karina que prepare la comida esta noche",
    "Quiero que le mandes un mensaje a Karina para que prepare la comida esta noche",
    "Me podés avisar a Karina que prepare la comida esta noche",
    "Hola Robertito, mandale a Karina que ya salí",
    "Che Robert, avisale a la Karina que venga",
    "Mandale un mensaje a Karina diciéndole que venga",
    "Mandale a Karina un mensaje que ya salí",
    "Mandale a Karina de que ya salí",
    "Mandale mensaje a Karina que prepare la comida",
    "Podrías mandarle a Karina que ya llegué",
    "Decile a Karina si puede comprar pan",
    "Avísale a Karina que prepare la comida esta noche",
    "Mándale a Karina que prepare la comida esta noche",
    "Envíale a Karina que prepare la comida esta noche",
  ]) {
    const intent = detectFamilyMessageIntent(phrase, karina);
    assert.equal(intent.type, "send", phrase);
    assert.equal(intent.recipientId, karina[0].id, phrase);
  }
});

test("keeps written accents in the content of an accented voice transcript", () => {
  const carinaRoster = [{ id: "c111", name: "Carina Ruiz" }];
  const intent = detectFamilyMessageIntent("Avísale a Carina que mañana nos vemos", carinaRoster);
  assert.equal(intent.type, "send");
  assert.equal(intent.recipientId, "c111");
  assert.equal(intent.content, "mañana nos vemos");
});

test("asks for clarification when a first name is ambiguous", () => {
  const intent = detectFamilyMessageIntent("Decile a Gustavo que compre carne", members);
  assert.equal(intent.type, "clarify");
  assert.match(intent.answer, /más de un integrante/i);
  assert.match(intent.answer, /No envié/i);
});

test("does not send to an unknown recipient", () => {
  const intent = detectFamilyMessageIntent("Mandale a Roberto que llegue temprano", members);
  assert.equal(intent.type, "clarify");
  assert.match(intent.answer, /No envié/i);
});

test("recognizes family wide messages and queries", () => {
  assert.equal(detectFamilyMessageIntent("Avisales a todos que hoy cenamos a las nueve", members).recipientId, null);
  assert.equal(detectFamilyMessageIntent("Enviá un mensaje para todos que hoy cenamos a las nueve", members).recipientId, null);
  assert.equal(detectFamilyMessageIntent("¿Tengo mensajes pendientes?", members).type, "unread");
  assert.equal(detectFamilyMessageIntent("¿Qué mensajes hay pendientes?", members).type, "unread");
  assert.equal(detectFamilyMessageIntent("¿Gustavo leyó mi mensaje?", members).type, "read_status");
  assert.equal(detectFamilyMessageIntent("Mostrame los últimos mensajes de la familia", members).type, "list");
});

test("resolves a uniquely mentioned member", () => {
  assert.equal(findMentionedMember("¿María leyó el mensaje?", members), members[2]);
  assert.equal(findMentionedMember("¿Gustavo leyó el mensaje?", members), null);
});

test("matches phonetically equivalent names like Carina and Karina in both directions", () => {
  const carinaRoster = [{ id: "c111", name: "Carina Ruiz" }];
  const intentVoiceKarina = detectFamilyMessageIntent("avisale a Karina que nos vemos esta noche", carinaRoster);
  assert.equal(intentVoiceKarina.type, "send");
  assert.equal(intentVoiceKarina.recipientId, "c111");
  assert.equal(intentVoiceKarina.content, "nos vemos esta noche");

  const karinaRoster = [{ id: "k111", name: "Karina Ruiz" }];
  const intentVoiceCarina = detectFamilyMessageIntent("avisale a Carina que nos vemos esta noche", karinaRoster);
  assert.equal(intentVoiceCarina.type, "send");
  assert.equal(intentVoiceCarina.recipientId, "k111");
  assert.equal(intentVoiceCarina.content, "nos vemos esta noche");
});
