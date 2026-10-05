import { store } from "./store.js";

let unlocked = false;
let speaking = false;
let cachedVoice = null;
let onSpeak = () => {};
const queue = [];
let playing = false;
let watch = 0;
let currentUtter = null;
let speakGen = 0;
let voicesReady = false;

const FEMALE = /paulina|m[oó]nica|monica|luc[ií]a|pen[eé]lope|lupe|conchita|lola|salom[eé]|mar[ií]a|sof[ií]a|camila|isabela|dalia|fernanda|m[ií]a\b|paloma|rosa|carmen|laura|andrea|valentina|ximena|elena|ana\b|sabrina|isabel|carla|paola|female|femenin|mujer|woman/i;
const MALE = /juan|diego|jorge|carlos|enrique|miguel|pablo|pedro|santiago|andr[eé]s|alberto|francisco|antonio|male|masculin|hombre|\bman\b/i;

function isAppleTouch() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPod|iPad/i.test(ua)) return true;
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

export function onVoiceState(fn) {
  onSpeak = typeof fn === "function" ? fn : () => {};
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

/**
 * Limpia texto ANTES de enviarlo al sintetizador.
 * Nunca deja pasar JSON, URLs, DNI, códigos QR crudos ni símbolos.
 */
export function prepareSpeakText(raw, { nameOnly = false } = {}) {
  let s = String(raw == null ? "" : raw).replace(/\u0000/g, " ").trim();
  if (!s) return "";
  if (/^\s*[{\[]/.test(s)) return "";
  if (/^QB1\|/i.test(s)) return "";
  if (/https?:\/\//i.test(s) || /www\./i.test(s)) return "";
  if (/[{}\[\]\\]/.test(s) && /[:,\"]/.test(s)) return "";
  if (/^\d{6,}$/.test(s.replace(/\s/g, ""))) return "";
  s = s
    .replace(/["'`´""''«»]/g, " ")
    .replace(/[{}\[\]\\|<>@#$%^&*_+=~`]+/g, " ")
    .replace(/[;:/]+/g, " ")
    .replace(/\b\d{8,14}\b/g, " ");
  if (nameOnly) {
    s = s.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ'\s-]+/g, " ");
  } else {
    s = s.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9'\s.,!?-]+/g, " ");
  }
  s = s.replace(/\s+/g, " ").trim();
  if (s.length < 2) return "";
  if (/^[\d\s.,!?-]+$/.test(s)) return "";
  return s;
}

function toSpeakCase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/(^|[\s'-])\S/g, (c) => c.toUpperCase());
}

/** Nombre limpio para voz: solo letras/espacios, sin DNI ni basura. */
export function prepareSpeakName(personOrText) {
  let raw = "";
  if (personOrText && typeof personOrText === "object") {
    raw = String(
      personOrText.nombreCompleto
      || [personOrText.apellido, personOrText.nombre].filter(Boolean).join(" ")
      || personOrText.apellido
      || personOrText.nombre
      || ""
    );
  } else {
    raw = String(personOrText || "");
  }
  const clean = prepareSpeakText(raw, { nameOnly: true });
  return clean ? toSpeakCase(clean) : "";
}

export function unlockVoice() {
  const s = synth();
  if (!s) return;
  try {
    if (s.paused) s.resume();
  } catch { /* iPhone */ }
  pickVoice();
  if (unlocked) return;
  unlocked = true;
  if (isAppleTouch()) return;
  try {
    const u = new SpeechSynthesisUtterance(" ");
    currentUtter = u;
    u.volume = 0.01;
    u.rate = 2;
    u.lang = "es-PE";
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
  if (v.localService === true) n += 32;
  if (v.localService === false) n -= 6;
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
  voicesReady = true;
  const ranked = voices
    .map((v) => ({ v, s: voiceScore(v) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  cachedVoice = ranked[0]?.v
    || voices.find((v) => v.localService !== false && /^es/i.test(v.lang) && FEMALE.test(`${v.name} ${v.voiceURI}`))
    || voices.find((v) => v.localService !== false && /^es/i.test(v.lang) && !MALE.test(`${v.name} ${v.voiceURI}`))
    || voices.find((v) => v.localService !== false && /^es/i.test(v.lang))
    || voices.find((v) => /^es/i.test(v.lang) && FEMALE.test(`${v.name} ${v.voiceURI}`))
    || voices.find((v) => /^es/i.test(v.lang) && !MALE.test(`${v.name} ${v.voiceURI}`))
    || voices.find((v) => /^es/i.test(v.lang))
    || voices.find((v) => v.localService !== false)
    || null;
  return cachedVoice;
}

function finishPlay(gen) {
  if (gen !== speakGen) return;
  playing = false;
  speaking = false;
  currentUtter = null;
  onSpeak(false, "");
  window.clearTimeout(watch);
  // En Android, hablar otra frase al instante deletrea el texto letra por letra.
  const delay = isAppleTouch() ? 80 : 280;
  window.setTimeout(() => {
    if (gen !== speakGen) return;
    playNext();
  }, delay);
}

function asJob(item) {
  if (item && typeof item === "object") return item;
  return { text: String(item || ""), onDone: null };
}

function fireDone(job) {
  if (!job || job._fired) return;
  job._fired = true;
  try { job.onDone?.(); } catch { /* no trabar la entrada */ }
}

function playNext() {
  const s = synth();
  if (!s || playing || !queue.length || !voiceEnabled()) return;
  try {
    if (s.paused) s.resume();
  } catch { /* iPhone */ }
  const job = asJob(queue.shift());
  const phrase = job.text;
  if (!phrase) {
    fireDone(job);
    playNext();
    return;
  }
  const gen = speakGen;
  playing = true;
  speaking = true;
  onSpeak(true, phrase);
  const u = new SpeechSynthesisUtterance(phrase);
  currentUtter = u;
  const v = pickVoice();
  u.lang = v?.lang || "es-PE";
  // rate o pitch distintos de 1 hacen que Chrome en Android deletree cada letra.
  u.rate = 1;
  u.pitch = 1;
  u.volume = 1;
  if (v) u.voice = v;
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    finishPlay(gen);
    fireDone(job);
  };
  u.onstart = () => {
    if (isAppleTouch()) return;
    const eng = synth();
    if (!eng) return;
    try {
      eng.pause();
      eng.resume();
    } catch { /* el motor ya está leyendo la frase completa */ }
  };
  u.onend = () => done();
  u.onerror = () => done();
  const ms = Math.min(14000, Math.max(2800, phrase.length * 150));
  watch = window.setTimeout(() => done(), ms);
  try {
    s.speak(u);
  } catch {
    done();
  }
}

function hardFlush() {
  speakGen += 1;
  queue.length = 0;
  playing = false;
  speaking = false;
  currentUtter = null;
  window.clearTimeout(watch);
  const s = synth();
  try { s?.cancel(); } catch { /* ignore */ }
  try { if (s?.paused) s.resume(); } catch { /* iPhone */ }
  onSpeak(false, "");
}

export function speak(text, opts = {}) {
  let fired = false;
  const done = () => {
    if (fired) return;
    fired = true;
    try { opts.onDone?.(); } catch { /* no trabar la entrada */ }
  };
  try {
    if (!voiceEnabled()) { done(); return; }
    const phrase = prepareSpeakText(text, { nameOnly: false });
    if (!phrase) { done(); return; }
    unlockVoice();
    const s = synth();
    if (!s) { done(); return; }
    const job = { text: phrase, onDone: done };
    if (opts.flush) {
      hardFlush();
      queue.push(job);
      const gen = speakGen;
      const delay = isAppleTouch() ? 120 : 320;
      window.setTimeout(() => {
        if (gen !== speakGen) { done(); return; }
        playNext();
      }, delay);
      return;
    }
    if (queue.length) queue.length = 0;
    queue.push(job);
    playNext();
  } catch {
    playing = false;
    speaking = false;
    currentUtter = null;
    done();
  }
}

/** Dice el nombre sin bloquear el escáner. Si ya habla, deja solo el último pendiente. */
export function speakPersonName(personOrText) {
  const name = prepareSpeakName(personOrText);
  if (!name) return;
  try {
    if (!voiceEnabled()) return;
    unlockVoice();
    if (!synth()) return;
    if (playing || speaking) {
      queue.length = 0;
      queue.push({ text: name, onDone: null });
      return;
    }
    speak(name);
  } catch {
    playing = false;
    speaking = false;
  }
}

export function speakApellido(apellido) {
  speakPersonName(apellido);
}

export function isSpeaking() {
  return speaking;
}

if (typeof speechSynthesis !== "undefined") {
  const onVoices = () => {
    pickVoice();
    if (voicesReady && queue.length && !playing) playNext();
  };
  if (typeof speechSynthesis.addEventListener === "function") {
    speechSynthesis.addEventListener("voiceschanged", onVoices);
  } else {
    speechSynthesis.onvoiceschanged = onVoices;
  }
  pickVoice();
}
