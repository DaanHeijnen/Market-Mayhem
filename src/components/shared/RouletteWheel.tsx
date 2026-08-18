import { useEffect, useMemo, useState } from 'react';

const ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

export function RouletteWheel({ status, resultNumber }: { status?: string; resultNumber?: number | null }) {
  const target = useMemo(() => {
    if (resultNumber == null) return 0;
    const index = ORDER.indexOf(resultNumber);
    const step = 360 / ORDER.length;
    // Align the centre of the server-selected pocket with the fixed ball at
    // twelve o'clock. Targeting the pocket boundary makes neighbouring
    // numbers look ambiguous on a projector.
    return index < 0 ? 0 : -((index + 0.5) * step);
  }, [resultNumber]);
  const wheelBackground = useMemo(() => {
    const step = 360 / ORDER.length;
    return `conic-gradient(${ORDER.map((n, index) => {
      const color = n === 0 ? '#064E3B' : RED.has(n) ? '#7F1D1D' : '#111827';
      return `${color} ${(index * step).toFixed(4)}deg ${((index + 1) * step).toFixed(4)}deg`;
    }).join(',')})`;
  }, []);
  const [rotation, setRotation] = useState(target);

  useEffect(() => {
    if (status === 'SPINNING' && resultNumber != null) {
      setRotation(current => current + 360 * 7 + target - (current % 360));
    } else if (resultNumber != null) {
      setRotation(current => current + target - (current % 360));
    }
  }, [status, resultNumber, target]);

  return (
    <div className={`roulette-wheel-stage ${status === 'SPINNING' ? 'is-spinning' : ''}`}>
      <div className="roulette-wheel" style={{ transform: `rotate(${rotation}deg)`, background: wheelBackground }}>
        {ORDER.map((n, index) => {
          const angle = index * (360 / ORDER.length);
          return <span key={n} className={`wheel-number ${n === 0 ? 'green' : RED.has(n) ? 'red' : 'black'}`} style={{ transform: `rotate(${angle}deg) translateY(-46%) rotate(${-angle}deg)` }}>{n}</span>;
        })}
      </div>
      <div className="roulette-ball-track"><div className="roulette-ball" /></div>
      {status !== 'SPINNING' && resultNumber != null && <div className="wheel-result"><span>WINNING NUMBER</span><b>{resultNumber}</b></div>}
    </div>
  );
}
