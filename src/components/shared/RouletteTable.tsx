const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

export type RoulettePosition = { betType: 'NUMBER'|'COLOR'|'PARITY'|'RANGE'; selection: string };
export type RouletteMarker = RoulettePosition & { id?: number|string; stake: number; displayName?: string; color?: string; pending?: boolean };

const numbers = Array.from({ length: 36 }, (_, i) => i + 1);
const outside: Array<RoulettePosition & { label: string }> = [
  { betType: 'RANGE', selection: 'LOW', label: '1–18' },
  { betType: 'PARITY', selection: 'EVEN', label: 'EVEN' },
  { betType: 'COLOR', selection: 'RED', label: 'RED' },
  { betType: 'COLOR', selection: 'BLACK', label: 'BLACK' },
  { betType: 'PARITY', selection: 'ODD', label: 'ODD' },
  { betType: 'RANGE', selection: 'HIGH', label: '19–36' },
];

function same(a: RoulettePosition, b: RoulettePosition) {
  return a.betType === b.betType && a.selection === b.selection;
}

export function RouletteTable({ onSelect, markers = [], disabled = false, compact = false }: {
  onSelect?: (position: RoulettePosition) => void;
  markers?: RouletteMarker[];
  disabled?: boolean;
  compact?: boolean;
}) {
  const cell = (position: RoulettePosition, label: string, kind = '') => {
    const here = markers.filter(marker => same(marker, position));
    return (
      <button
        type="button"
        className={`roulette-cell ${kind} ${here.length ? 'has-chip' : ''}`}
        disabled={disabled || !onSelect}
        onClick={() => onSelect?.(position)}
        aria-label={`Bet ${label}`}
      >
        <span className="roulette-cell-label">{label}</span>
        {here.length > 0 && <div className="roulette-cell-chips">{here.slice(0, compact ? 2 : 4).map((marker, index) => (
          <span key={`${marker.id ?? 'm'}-${index}`} className={`roulette-marker ${marker.pending ? 'pending' : ''}`} style={marker.color ? { borderColor: marker.color } : undefined}>
            {marker.displayName && <small>{marker.displayName}</small>}<b>{marker.stake}</b>
          </span>
        ))}{here.length > (compact ? 2 : 4) && <span className="roulette-more">+{here.length - (compact ? 2 : 4)}</span>}</div>}
      </button>
    );
  };

  return (
    <div className={`roulette-table ${compact ? 'compact' : ''}`}>
      <div className="roulette-number-grid">
        <div className="roulette-zero">{cell({ betType: 'NUMBER', selection: '0' }, '0', 'green')}</div>
        <div className="roulette-numbers">
          {numbers.map(n => cell({ betType: 'NUMBER', selection: String(n) }, String(n), RED.has(n) ? 'red' : 'black'))}
        </div>
      </div>
      <div className="roulette-outside-grid">
        {outside.map(item => cell(item, item.label, item.selection.toLowerCase()))}
      </div>
    </div>
  );
}
