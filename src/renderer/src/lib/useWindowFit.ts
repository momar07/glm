import { useCallback, useEffect, useRef } from 'react';
import { isNativeShell } from './platform';

// Keeps the frameless Electron window hugging the rendered shell: just the
// slim phonebar when idle, taller while a drawer / status menu / incoming
// call panel is open, and sized to the compact card on the login screen.
//
// Attach `ref` to the shell's root element. Height is measured as the
// deepest descendant bottom relative to the root top, so absolutely-
// positioned drawers and the fixed incoming-call panel count too (they are
// not in flow). The measurement corrects for an in-progress drawerReveal
// transform, so it always yields the settled, final height and the window
// resizes once, in a single step. Reports go through win:set-size, only
// when the size actually changed.
//
// `fitNow()` measures and reports synchronously, in the current frame.
// Callers that open/close overlay panels (PhoneBar) invoke it from a layout
// effect so the resize IPC is issued before the panel paints — the window
// is already the right size when the panel becomes visible, instead of
// growing a frame later (which read as a transparent flicker). No-op
// outside the Electron shell (web/Capacitor have no window to resize).
export interface WindowFit {
  ref: (el: HTMLElement | null) => void;
  fitNow: () => void;
}

export function useWindowFit(width: number): WindowFit {
  const widthRef = useRef(width);
  widthRef.current = width;
  const rootRef = useRef<HTMLElement | null>(null);
  const lastRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const cleanupRef = useRef<() => void>(() => {});

  // A new width target (login card <-> bar) must re-report even at same height.
  useEffect(() => {
    lastRef.current = { w: 0, h: lastRef.current.h };
  }, [width]);

  const report = useCallback((): void => {
    const el = rootRef.current;
    if (!el || !isNativeShell) return;
    const top = el.getBoundingClientRect().top;
    let bottom = 0;
    el.querySelectorAll('*').forEach((n) => {
      const node = n as HTMLElement;
      const r = node.getBoundingClientRect();
      if (r.height <= 0) return;
      let b = r.bottom - top;
      // A descendant inside a drawerReveal animation is painted translateY'd
      // away from its final spot; measuring the painted rect would size the
      // window to a mid-animation height and step it again when the
      // animation settles. Subtract the animating ancestor's current
      // translateY so the measurement is the final layout bottom.
      let a: HTMLElement | null = node;
      while (a && a !== el) {
        if (a.classList?.contains('drawer-animate')) {
          const t = getComputedStyle(a).transform;
          if (t && t !== 'none') {
            const m = new DOMMatrixReadOnly(t);
            if (Number.isFinite(m.f)) b -= m.f;
          }
          break;
        }
        a = a.parentElement;
      }
      if (b > bottom) bottom = b;
    });
    const padBottom = parseFloat(getComputedStyle(el).paddingBottom) || 0;
    const height = Math.ceil(bottom + padBottom);
    const w = widthRef.current;
    if (height <= 0) return;
    if (Math.abs(height - lastRef.current.h) < 2 && w === lastRef.current.w) return;
    lastRef.current = { w, h: height };
    void window.api.setWindowSize({ width: w, height }).catch(() => {});
  }, []);

  const fitNow = useCallback((): void => {
    report();
  }, [report]);

  const ref = useCallback(
    (el: HTMLElement | null): void => {
      cleanupRef.current();
      cleanupRef.current = () => {};
      rootRef.current = el;
      if (!el || !isNativeShell) return;

      let raf = 0;
      const schedule = (): void => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(report);
      };

      const ro = new ResizeObserver(schedule);
      ro.observe(el);
      const mo = new MutationObserver(schedule);
      mo.observe(el, { subtree: true, attributes: true, childList: true, characterData: true });
      // Clocks in the bar re-render every second; a slow poll also catches
      // layout shifts no observer saw (fonts loading, async content). With
      // the transform-corrected measurement it lands on the same final
      // size, so it never produces a second, corrective step.
      const poll = setInterval(report, 600);
      schedule();

      cleanupRef.current = () => {
        ro.disconnect();
        mo.disconnect();
        clearInterval(poll);
        cancelAnimationFrame(raf);
      };
    },
    [report],
  );

  return { ref, fitNow };
}
