import { useState } from 'react';

export const mediaUrl = (key: string) => `/api/block-media?key=${encodeURIComponent(key)}`;

/**
 * One uploaded photo in the Admin, with a way to actually look at it.
 *
 * A judging grid at thumbnail size is not enough to judge from, so every photo opens full
 * screen on click. The large view is the same URL as the thumbnail — one blob store, one
 * access path, no second copy of the image anywhere.
 *
 * Both failure modes are drawn rather than left to the browser. A submission with no key
 * is a row whose upload never completed; a key whose blob is gone is an upload that was
 * lost. Either way the host sees which team is affected instead of a broken-image glyph,
 * and neither takes the page down with it.
 */
export function PhotoThumb({ mediaKey, alt = '', className = 'photo-card-image' }: { mediaKey: string | null | undefined; className?: string; alt?: string }) {
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);

  if (!mediaKey) {
    return <div className={`${className} photo-missing-media`}>
      <span>Geen foto opgeslagen</span>
    </div>;
  }
  if (broken) {
    return <div className={`${className} photo-missing-media`}>
      <span>Foto kon niet geladen worden</span>
    </div>;
  }

  return <>
    <img
      className={`${className} is-clickable`}
      src={mediaUrl(mediaKey)}
      alt={alt}
      loading="lazy"
      onError={() => setBroken(true)}
      onClick={() => setOpen(true)}
    />
    {open && <div className="photo-lightbox" role="dialog" aria-label="Foto" onClick={() => setOpen(false)}>
      <img src={mediaUrl(mediaKey)} alt={alt} />
      <button className="btn btn-secondary photo-lightbox-close" onClick={() => setOpen(false)}>SLUITEN</button>
    </div>}
  </>;
}
