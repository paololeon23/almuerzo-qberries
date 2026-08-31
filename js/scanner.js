export class FieldScanner {
  constructor() {
    this.stream = null;
    this.timer = null;
    this.active = false;
    this.detector = null;
    this.gen = 0;
    this.lastCode = "";
    this.lastAt = 0;
    this.seen = new Map();
    this.canvas = null;
    this.ctx = null;
  }

  async start(videoEl, onCode) {
    const gen = ++this.gen;
    await this.stop(true);
    this.active = true;
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
        video: { facingMode: { ideal: "environment" } },
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

    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }

    const emit = (value) => {
      const text = String(value || "").trim();
      if (!text) return;
      const now = Date.now();
      const prev = this.seen.get(text) || 0;
      if (now - prev < 1400) return;
      this.seen.set(text, now);
      this.lastCode = text;
      this.lastAt = now;
      onCode(text);
    };

    const tick = async () => {
      if (!this.active || gen !== this.gen) return;
      if (videoEl.readyState >= 2 && videoEl.videoWidth) {
        const vw = videoEl.videoWidth;
        const vh = videoEl.videoHeight;
        const side = Math.min(vw, vh);
        const sx = (vw - side) / 2;
        const sy = (vh - side) / 2;
        const size = 400;
        this.canvas.width = size;
        this.canvas.height = size;
        this.ctx.drawImage(videoEl, sx, sy, side, side, 0, 0, size, size);

        let value = "";
        if (this.detector) {
          try {
            const codes = await this.detector.detect(this.canvas);
            value = String(codes?.[0]?.rawValue || "").trim();
          } catch {
            /* next decoder */
          }
        }
        if (!value && window.jsQR) {
          try {
            const img = this.ctx.getImageData(0, 0, size, size);
            const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
            value = String(code?.data || "").trim();
          } catch {
            /* frame skip */
          }
        }
        if (value) emit(value);
      }
      this.timer = setTimeout(tick, 80);
    };
    tick();
    return true;
  }

  async stop(keepGen = false) {
    this.active = false;
    if (!keepGen) this.gen += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      cancelAnimationFrame(this.timer);
      this.timer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.detector = null;
  }
}
