export function CoinIcon({ size = 24 }: { size?: number }) {
  return (
    <svg className="coin-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.2" />
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M14.8 8.7c-.6-.55-1.48-.9-2.6-.9-1.6 0-2.7.78-2.7 1.92 0 1.12.9 1.58 2.65 1.9 1.5.28 2.05.55 2.05 1.25 0 .72-.73 1.18-1.9 1.18-1.17 0-2.13-.4-2.9-1.08" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M12 6.6v10.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
