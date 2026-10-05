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
    this.pending = null;
    this._jsqrPromise = null;
    this._tickRunning = false;
  }

  async ensureJsQr() {
    if (window.jsQR) return;
    if (this._jsqrPromise) return this._jsqrPromise;
    this._jsqrPromise = this._loadJsQr().finally(() => {
      if (!window.jsQR) this._jsqrPromise = null;
    });
    return this._jsqrPromise;
  }

  _injectScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.dataset.qbJsqr = "1";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("jsqr"));
      document.head.appendChild(s);
    });
  }

  async _loadJsQr() {
    if (window.jsQR) return;
    try {
      await this._injectScript("./js/vendor/jsqr.js");
    } catch {
      /* sin red el archivo igual puede estar en la caché de la app */
    }
    if (window.jsQR) return;
    if (!("caches" in window)) throw new Error("jsqr");
    const hit = await caches.match("./js/vendor/jsqr.js", { ignoreSearch: true });
    if (!hit) throw new Error("jsqr");
    const blob = new Blob([await hit.text()], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await this._injectScript(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    if (!window.jsQR) throw new Error("jsqr");
  }

  _openCamera() {
    const md = navigator.mediaDevices;
    const attempts = [
      { audio: false, video: { facingMode: { ideal: "environment" } } },
      { audio: false, video: true },
    ];
    const run = (i) => md.getUserMedia(attempts[i]).catch((err) => {
      const name = err?.name || "";
      if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") throw err;
      if (i + 1 < attempts.length) return run(i + 1);
      throw err;
    });
    return run(0);
  }

  _armDetector() {
    this.detector = null;
    this._detectFails = 0;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (!("BarcodeDetector" in window)) return;
    try {
      this.detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    } catch {
      try { this.detector = new window.BarcodeDetector(); } catch { this.detector = null; }
    }
  }

  async _play(videoEl) {
    try {
      await videoEl.play();
      return;
    } catch { /* un frame más y se reintenta */ }
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    await videoEl.play();
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this._flushPending();
  }

  setBusy(on) {
    const next = !!on;
    this.busy = next;
    if (!next) this._flushPending();
  }

  /** No bloquea otros códigos. Se mantiene por compatibilidad. */
  lock(ms = 0) {
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

  _cutStream() {
    this.active = false;
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
    const video = this.videoEl;
    if (video) {
      try {
        video.pause();
        video.srcObject = null;
      } catch { /* ignore */ }
    }
  }

  async start(videoEl, onCode, onBusy, opts = {}) {
    const gesture = !!opts.gesture;
    const showing = this.isLiveOn(videoEl) && videoEl.videoWidth > 0;
    if (!gesture && showing) {
      this.bindHandlers(onCode, onBusy);
      this.paused = false;
      this._flushPending();
      if (!this.timer && !this._tickRunning) this._scheduleTick(this.gen);
      return true;
    }
    if (!gesture && this._opening) {
      this.bindHandlers(onCode, onBusy);
      return this._opening;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("sin_camara");

    if (gesture) this._cutStream();
    // getUserMedia va en este mismo toque, antes de cualquier await.
    const camPromise = this._openCamera();
    const gen = ++this.gen;
    const run = this._begin(gen, videoEl, onCode, onBusy, camPromise);
    this._opening = run.finally(() => {
      if (this._opening === run) this._opening = null;
    });
    return this._opening;
  }

  async _begin(gen, videoEl, onCode, onBusy, camPromise) {
    try {
      await this.stop(true);
      if (gen !== this.gen) {
        this._releaseLater(camPromise);
        return false;
      }
      this.active = true;
      this.paused = false;
      this.busy = false;
      this.pending = null;
      this.videoEl = videoEl;
      this.bindHandlers(onCode, onBusy);
      this._armDetector();

      const stream = await camPromise;
      if (gen !== this.gen || !this.active) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      const target = (document.getElementById("cam") && document.body.contains(videoEl))
        ? videoEl
        : (document.getElementById("cam") || videoEl);
      this.videoEl = target;
      this.stream = stream;
      target.srcObject = stream;
      target.muted = true;
      target.playsInline = true;
      target.setAttribute("playsinline", "true");
      target.setAttribute("webkit-playsinline", "true");
      try {
        await this._play(target);
      } catch {
        stream.getTracks().forEach((t) => t.stop());
        if (this.stream === stream) this.stream = null;
        throw new Error("sin_camara");
      }
      if (gen !== this.gen || !this.active) return false;

      if (!window.jsQR) this.ensureJsQr().catch(() => {});
      if (!this.canvas) {
        this.canvas = document.createElement("canvas");
        this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
      }
      this._scheduleTick(gen);
      return true;
    } catch (err) {
      if (gen === this.gen) {
        this.active = false;
        if (this.stream) {
          this.stream.getTracks().forEach((t) => t.stop());
          this.stream = null;
        }
      }
      this._releaseLater(camPromise);
      throw err;
    }
  }

  _releaseLater(camPromise) {
    camPromise.then((stream) => {
      if (this.stream !== stream) stream.getTracks().forEach((t) => t.stop());
    }).catch(() => {});
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
      const hold = this.paused;

      if (!hold && videoEl.readyState >= 2 && videoEl.videoWidth) {
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
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        if (offline) this.detector = null;
        if (this.detector) {
          try {
            const codes = await Promise.race([
              this.detector.detect(this.canvas),
              new Promise((_, reject) => window.setTimeout(() => reject(new Error("detect_timeout")), 400)),
            ]);
            if (gen !== this.gen || !this.active) return;
            value = String(codes?.[0]?.rawValue || "").trim();
            this._detectFails = 0;
          } catch {
            this._detectFails = (this._detectFails || 0) + 1;
            if (this._detectFails >= 2) this.detector = null;
          }
        }
        if (!value && !window.jsQR) this.ensureJsQr().catch(() => {});
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
        nextDelay = this.busy ? 80 : 55;
      } else {
        nextDelay = hold ? 110 : (this.busy ? 90 : 70);
      }
    } finally {
      this._tickRunning = false;
      if (this.active && gen === this.gen) {
        this.timer = setTimeout(() => this._tick(gen), nextDelay);
      }
    }
  }

  _flushPending() {
    const p = this.pending;
    if (!p || this.busy || this.paused || !this.active) return;
    this.pending = null;
    queueMicrotask(() => {
      if (this.busy || this.paused || !this.active) {
        if (!this.pending) this.pending = p;
        return;
      }
      this._emit(p.text, this.gen);
    });
  }

  _emit(value, gen) {
    if (!this.active || this.paused || gen !== this.gen) return;
    const now = Date.now();
    const text = String(value || "").trim();
    if (!text) return;
    const key = this.emitKey(text);
    if (!key) return;

    if (this.busy) {
      const current = this.emitKey(this.lastCode);
      if (key !== current) this.pending = { text, key };
      if (key !== current && now - this.lastBusyNotify >= 1200) {
        this.lastBusyNotify = now;
        try { this.onBusy?.(text, key); } catch { /* ignore */ }
      }
      return;
    }

    const prev = this.seen.get(key) || 0;
    if (now - prev < 700) return;
    if (this.seen.size > 80) {
      for (const [k, t] of this.seen) {
        if (now - t > 8000) this.seen.delete(k);
      }
    }
    this.seen.set(key, now);
    this.lastCode = text;
    this.lastAt = now;
    try {
      const ret = this.onCode?.(text, key);
      if (ret && typeof ret.then === "function") ret.catch(() => {});
    } catch {
      /* no tumbar el loop */
    }
  }

  forget(text) {
    const key = this.emitKey(text);
    if (key) this.seen.delete(key);
    if (key && this.emitKey(this.lastCode) === key) {
      this.lastCode = "";
      this.lastAt = 0;
    }
    if (key && this.pending && this.pending.key === key) this.pending = null;
    this.lockUntil = 0;
  }

  async stop(keepGen = false) {
    this.active = false;
    this.paused = false;
    this.busy = false;
    this.pending = null;
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
