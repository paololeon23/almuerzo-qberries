export class FieldScanner {
  constructor() {
    this.stream = null;
    this.timer = null;
    this.active = false;
    this.paused = false;
    this.busy = false;
    this.detector = null;
    this.gen = 0;
    this.lastCode = "";
    this.lastAt = 0;
    this.lockUntil = 0;
    this.lastBusyNotify = 0;
    this.seen = new Map();
    this.canvas = null;
    this.ctx = null;
    this.videoEl = null;
    this.onCode = null;
    this.onBusy = null;
    this._jsqrPromise = null;
    this._tickRunning = false;
  }

  async ensureJsQr() {
    if (window.jsQR) return;
    if (this._jsqrPromise) return this._jsqrPromise;
    this._jsqrPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-qb-jsqr]');
      if (existing) {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("jsqr")));
        if (window.jsQR) resolve();
        return;
      }
      const s = document.createElement("script");
      s.src = "./js/vendor/jsqr.js";
      s.async = true;
      s.dataset.qbJsqr = "1";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("jsqr"));
      document.head.appendChild(s);
    }).finally(() => {
      if (!window.jsQR) this._jsqrPromise = null;
    });
    return this._jsqrPromise;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  setBusy(on) {
    this.busy = !!on;
  }

  /** Bloquea emisiones unos ms tras un hit. */
  lock(ms = 900) {
    this.lockUntil = Date.now() + Math.max(0, Number(ms) || 0);
  }

  emitKey(text) {
    const digits = String(text || "").replace(/\D/g, "");
    if (digits.length >= 8) return digits.slice(0, 8);
    return String(text || "").trim();
  }

  /** Reusa stream si ya está vivo en el mismo <video>. */
  isLiveOn(videoEl) {
    return !!(
      this.active
      && this.stream
      && this.videoEl === videoEl
      && videoEl?.srcObject
      && this.stream.active !== false
    );
  }

  bindHandlers(onCode, onBusy) {
    this.onCode = onCode;
    this.onBusy = onBusy || null;
  }

  async start(videoEl, onCode, onBusy) {
    if (this.isLiveOn(videoEl)) {
      this.bindHandlers(onCode, onBusy);
      this.paused = false;
      // No resetear busy: un proceso activo debe seguir bloqueado.
      if (!this.timer && !this._tickRunning) this._scheduleTick(this.gen);
      return true;
    }

    const gen = ++this.gen;
    await this.stop(true);
    this.active = true;
    this.paused = false;
    this.busy = false;
    this.videoEl = videoEl;
    this.bindHandlers(onCode, onBusy);

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("sin_camara");
    }
    if ("BarcodeDetector" in window) {
      try {
        this.detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      } catch {
        try { this.detector = new window.BarcodeDetector(); } catch { this.detector = null; }
      }
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    }
    if (gen !== this.gen) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.stream = stream;
    videoEl.srcObject = stream;
    videoEl.setAttribute("playsinline", "true");
    videoEl.setAttribute("webkit-playsinline", "true");
    videoEl.muted = true;
    videoEl.playsInline = true;
    try {
      await videoEl.play();
    } catch {
      throw new Error("sin_camara");
    }
    if (gen !== this.gen) return false;

    if (!this.detector) {
      try { await this.ensureJsQr(); } catch { /* cámara igual abre */ }
    }
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }

    this._scheduleTick(gen);
    return true;
  }

  _scheduleTick(gen) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => this._tick(gen), 0);
  }

  async _tick(gen) {
    if (!this.active || gen !== this.gen) return;
    if (this._tickRunning) {
      this.timer = setTimeout(() => this._tick(gen), 100);
      return;
    }
    this._tickRunning = true;
    const videoEl = this.videoEl;
    let nextDelay = 100;
    try {
      if (!videoEl) return;
      const now = Date.now();
      const locked = now < this.lockUntil;
      const hold = this.paused;

      if (!hold && !locked && videoEl.readyState >= 2 && videoEl.videoWidth) {
        const vw = videoEl.videoWidth;
        const vh = videoEl.videoHeight;
        const side = Math.min(vw, vh);
        const sx = (vw - side) / 2;
        const sy = (vh - side) / 2;
        const size = 320;
        if (this.canvas.width !== size) {
          this.canvas.width = size;
          this.canvas.height = size;
        }
        this.ctx.drawImage(videoEl, sx, sy, side, side, 0, 0, size, size);

        let value = "";
        if (this.detector) {
          try {
            const codes = await this.detector.detect(this.canvas);
            if (gen !== this.gen || !this.active) return;
            value = String(codes?.[0]?.rawValue || "").trim();
          } catch {
            /* next decoder */
          }
        }
        if (!value && window.jsQR) {
          try {
            const img = this.ctx.getImageData(0, 0, size, size);
            const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            value = String(code?.data || "").trim();
          } catch {
            /* frame skip */
          }
        }
        if (value) this._emit(value, gen);
        nextDelay = this.busy ? 160 : 95;
      } else {
        nextDelay = hold || locked || this.busy ? 160 : 110;
      }
    } finally {
      this._tickRunning = false;
      if (this.active && gen === this.gen) {
        this.timer = setTimeout(() => this._tick(gen), nextDelay);
      }
    }
  }

  _emit(value, gen) {
    if (!this.active || this.paused || gen !== this.gen) return;
    const now = Date.now();
    const text = String(value || "").trim();
    if (!text) return;
    const key = this.emitKey(text);
    if (!key) return;

    if (this.busy) {
      if (now - this.lastBusyNotify >= 1400) {
        this.lastBusyNotify = now;
        try { this.onBusy?.(text, key); } catch { /* ignore */ }
      }
      return;
    }

    if (now < this.lockUntil) return;

    const prev = this.seen.get(key) || 0;
    if (now - prev < 2000) return;
    if (this.seen.size > 50) {
      for (const [k, t] of this.seen) {
        if (now - t > 12000) this.seen.delete(k);
      }
    }
    this.seen.set(key, now);
    this.lastCode = text;
    this.lastAt = now;
    this.lock(400);
    try {
      this.onCode?.(text, key);
    } catch {
      /* no tumbar el loop */
    }
  }

  async stop(keepGen = false) {
    this.active = false;
    this.paused = false;
    this.busy = false;
    this.onCode = null;
    this.onBusy = null;
    this._tickRunning = false;
    if (!keepGen) this.gen += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
      this.stream = null;
    }
    if (this.videoEl) {
      try {
        this.videoEl.pause();
        this.videoEl.srcObject = null;
      } catch { /* ignore */ }
      this.videoEl = null;
    }
    this.detector = null;
  }
}
