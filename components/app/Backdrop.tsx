"use client";

import * as React from "react";

/** Living background: a drifting ember mesh (CSS) plus a glow that eases toward the
 *  pointer (JS sets --mx/--my, throttled by rAF). Disabled for reduced-motion and
 *  coarse (touch) pointers. */
export function Backdrop() {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fine = window.matchMedia("(pointer: fine)").matches;
    if (reduce || !fine) return;

    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.setProperty("--mx", `${(e.clientX / window.innerWidth) * 100}%`);
        el.style.setProperty("--my", `${(e.clientY / window.innerHeight) * 100}%`);
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div ref={ref} className="backdrop" aria-hidden>
      <div className="backdrop-mesh" />
      <div className="backdrop-glow" />
      <div className="backdrop-grain" />
    </div>
  );
}
