import { store } from "./store.js";

let unlocked = false;
let speaking = false;
let cachedVoice = null;
let onSpeak = () => {};
const queue = [];
let playing = false;
let watch = 0;

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

function synth() {
  return typeof speechSynthesis !== "undefined" ? speechSynthesis : null;
}

export function unlockVoice() {
  const s = synth();
  if (!s) return;
  try {
    if (s.paused) s.resume();
    pickVoice();
    if (unlocked) return;
    unlocked = true;
    const u = new SpeechSynthesisUtterance(".");
    u.volume = 0.01;
    u.rate = 2;
    u.lang = "es-MX";
    s.speak(u);
  } catch {
    unlocked = true;
  }
}

function voiceScore(v) {
  const lang = String(v.lang || "");
  if (!/^es/i.test(lang)) return -100;
  const blob = `${v.name} ${v.voiceURI}`;
  if (MALE.test(blob)) return -40;
  let n = 20;
  if (FEMALE.test(blob)) n += 60;
  if (/paulina/i.test(blob)) n += 24;
  if (/m[oó]nica|monica/i.test(blob)) n += 18;
  if (/es-PE/i.test(lang)) n += 16;
  if (/es-MX/i.test(lang)) n += 14;
  if (/es-US/i.test(lang)) n += 10;
  if (/es-ES/i.test(lang)) n += 8;
  return n;
}

function pickVoice() {
  const s = synth();
  if (!s) return null;
  const voices = s.getVoices() || [];
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

function finishPlay() {
  playing = false;
  speaking = false;
  onSpeak(false, "");
  window.clearTimeout(watch);
  window.setTimeout(playNext, 80);
}

function playNext() {
  const s = synth();
  if (!s || playing || !queue.length || !voiceEnabled()) return;
  if (s.paused) {
    try { s.resume(); } catch { /* iPhone */ }
  }
  const phrase = queue.shift();
  if (!phrase) {
    playNext();
    return;
  }
  playing = true;
  speaking = true;
  onSpeak(true, phrase);
  const u = new SpeechSynthesisUtterance(phrase);
  const v = pickVoice();
  u.lang = v?.lang || "es-MX";
  u.rate = 0.95;
  u.pitch = v && FEMALE.test(`${v.name} ${v.voiceURI}`) ? 1 : 1.18;
  if (v) u.voice = v;
  u.onend = finishPlay;
  u.onerror = finishPlay;
  watch = window.setTimeout(finishPlay, 8000);
  try {
    s.speak(u);
  } catch {
    finishPlay();
  }
}

export function speak(text, opts = {}) {
  if (!voiceEnabled() || !text) return;
  unlockVoice();
  const phrase = String(text).replace(/\s+/g, " ").trim();
  if (!phrase) return;
  if (opts.flush) {
    queue.length = 0;
    const s = synth();
    try { s?.cancel(); } catch { /* ignore */ }
    playing = false;
    speaking = false;
    window.clearTimeout(watch);
    window.setTimeout(() => {
      queue.push(phrase);
      playNext();
    }, 80);
    return;
  }
  queue.push(phrase);
  playNext();
}

export function speakApellido(apellido) {
  const a = String(apellido || "").replace(/\s+/g, " ").trim();
  if (!a) return;
  speak(a);
}

export function isSpeaking() {
  return speaking;
}

if (typeof speechSynthesis !== "undefined") {
  speechSynthesis.onvoiceschanged = () => {
    pickVoice();
    playNext();
  };
  pickVoice();
}
