'use client';
import {useEffect, useRef, useState} from 'react';

// Número que "sobe" até o valor final. Respeita quem prefere menos movimento.
export default function CountUp({value, format}: {value: number; format: (n: number) => string}) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const end = Number(value) || 0;
    const start = from.current;
    from.current = end;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || start === end) {
      setShown(end);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const duration = 900;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setShown(start + (end - start) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className="count-up">{format(shown)}</span>;
}
