function isPhone() {
  const ua = navigator.userAgent || "";
  if (/iPad/i.test(ua)) return false;
  if (/iPhone|iPod/i.test(ua)) return true;
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return true;
  return false;
}

export function isFieldDevice() {
  return isPhone();
}

export function bindAppHeight() {
  const root = document.documentElement;
  const apply = () => {
    root.style.setProperty("--app-height", `${Math.round(window.innerHeight)}px`);
    root.style.setProperty("--vv-offset", "0px");
  };
  apply();
  window.addEventListener("orientationchange", () => setTimeout(apply, 250));
}

export function bindFieldLock(onChange) {
  const check = () => onChange(isPhone());
  check();
  window.addEventListener("resize", check);
  window.addEventListener("orientationchange", () => setTimeout(check, 250));
}

let bounceBound = false;

export function preventBounce(scrollEl) {
  if (!bounceBound) {
    bounceBound = true;
    document.body.addEventListener("touchmove", (e) => {
      if (e.target === document.documentElement || e.target === document.body) {
        e.preventDefault();
      }
    }, { passive: false });
  }
  if (!scrollEl || scrollEl.dataset.bounce === "1") return;
  scrollEl.dataset.bounce = "1";
  let startY = 0;
  scrollEl.addEventListener("touchstart", (e) => {
    startY = e.touches[0].clientY;
  }, { passive: true });
  scrollEl.addEventListener("touchmove", (e) => {
    const y = e.touches[0].clientY;
    const up = y > startY;
    const down = y < startY;
    const { scrollTop, scrollHeight, clientHeight } = scrollEl;
    const atTop = scrollTop <= 0;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
    if ((atTop && up) || (atBottom && down)) {
      e.preventDefault();
    }
  }, { passive: false });
}
