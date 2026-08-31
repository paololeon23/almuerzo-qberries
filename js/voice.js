import { store } from "./store.js";

let unlocked = false;
let speaking = false;
let cachedVoice = null;
let onSpeak = () => {};

const FEMALE = /paulina|m[oó]nica|monica|luc[ií]a|pen[eé]lope|lupe|conchita|lola|salom[eé]|mar[ií]a|sof[ií]a|camila|isabela|dalia|fernanda|m[ií]a\b|paloma|rosa|carmen|laura|andrea|valentina|ximena|elena|ana\b|sabrina|isabel|carla|paola|female|femenin|mujer|woman/i;
const MALE = /juan|diego|jorge|carlos|enrique|miguel|pablo|pedro|santiago|andr[eé]s|alberto|francisco|antonio|male|masculin|hombre|\bman\b/i;

export function onVoiceState(fn) {
  onSpeak = fn;
}

export function voiceEnabled() {
  return store.getPrefs().voice !== false;
}

export function setVoiceEnabled(on) {
  store.setPrefs({ voice: !!on });
}

export function unlockVoice() {
  if (unlocked) return;
  unlocked = true;
  try {
    pickVoice();
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
    speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}

function voiceScore(v) {
  const lang = String(v.lang || "");
  if (!/^es/i.test(lang)) return -100;
  const blob = `${v.name} ${v.voiceURI}`;
  if (MALE.test(blob)) return -40;
  let s = 20;
  if (FEMALE.test(blob)) s += 60;
  if (/paulina/i.test(blob)) s += 24;
  if (/m[oó]nica|monica/i.test(blob)) s += 18;
  if (/es-PE/i.test(lang)) s += 16;
  if (/es-MX/i.test(lang)) s += 14;
  if (/es-US/i.test(lang)) s += 10;
  if (/es-ES/i.test(lang)) s += 8;
  if (/enhanced|premium|neural|compact|network/i.test(blob)) s += 3;
  return s;
}

function pickVoice() {
  if (typeof speechSynthesis === "undefined") return null;
  const voices = speechSynthesis.getVoices() || [];
  if (!voices.length) return cachedVoice;
  const ranked = voices
    .map((v) => ({ v, s: voiceScore(v) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  cachedVoice = ranked[0]?.v
    || voices.find((v) => /^es/i.test(v.lang) && FEMALE.test(`${v.name} ${v.voiceURI}`))
    || voices.find((v) => /^es/i.test(v.lang) && !MALE.test(`${v.name} ${v.voiceURI}`))
    || null;
  return cachedVoice;
}

export function speak(text, opts = {}) {
  if (!voiceEnabled() || !text) return;
  unlockVoice();
  const phrase = String(text).replace(/\s+/g, " ").trim();
  if (!phrase) return;
  try {
    speechSynthesis.cancel();
    const v = pickVoice();
    const u = new SpeechSynthesisUtterance(phrase);
    u.lang = v?.lang || "es-MX";
    u.rate = opts.rate || 0.95;
    u.pitch = v && FEMALE.test(`${v.name} ${v.voiceURI}`) ? 1 : 1.18;
    if (v) u.voice = v;
    speaking = true;
    onSpeak(true, phrase);
    u.onend = () => {
      speaking = false;
      onSpeak(false, "");
    };
    u.onerror = () => {
      speaking = false;
      onSpeak(false, "");
    };
    speechSynthesis.speak(u);
  } catch {
    speaking = false;
    onSpeak(false, "");
  }
}

export function speakApellido(apellido) {
  const a = String(apellido || "").trim();
  if (!a) {
    speak("Código leído. Identifica a la persona.");
    return;
  }
  speak(a);
}

export function isSpeaking() {
  return speaking;
}

if (typeof speechSynthesis !== "undefined") {
  speechSynthesis.onvoiceschanged = () => pickVoice();
  pickVoice();
}
