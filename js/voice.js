import { store } from "./store.js";

let unlocked = false;
let speaking = false;
let onSpeak = () => {};

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
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    speechSynthesis.speak(u);
    speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  return (
    voices.find((v) => /es-PE/i.test(v.lang)) ||
    voices.find((v) => /es-MX/i.test(v.lang)) ||
    voices.find((v) => /es-US/i.test(v.lang)) ||
    voices.find((v) => /^es/i.test(v.lang)) ||
    null
  );
}

export function speak(text, opts = {}) {
  if (!voiceEnabled() || !text) return;
  unlockVoice();
  const phrase = String(text).replace(/\s+/g, " ").trim();
  if (!phrase) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(phrase);
    u.lang = "es-PE";
    u.rate = opts.rate || 0.95;
    u.pitch = 1;
    const v = pickVoice();
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
}
