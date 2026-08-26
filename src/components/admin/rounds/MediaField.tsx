import { useRef, useState } from 'react';

/**
 * Image / audio picker for picture and music rounds.
 *
 * Uploads immediately to Netlify Blobs and hands back only the resulting key, which the
 * block payload stores. Nothing is base64'd into the payload — that would ride along in
 * every admin-state poll for the rest of the evening.
 *
 * The design draws the image slot as a drop target, so this accepts drag-and-drop as
 * well as click-to-browse.
 */
export function MediaField({ kind, gameId, value, name, onChange, label, hint }: {
  kind: 'image' | 'audio';
  gameId: number;
  value: string;
  name?: string;
  onChange: (next: { key: string; name: string }) => void;
  label: string;
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);

  const upload = async (file: File | undefined | null) => {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('gameId', String(gameId));
      form.append('kind', kind);
      form.append('file', file);
      const response = await fetch('/api/upload-block-media', { method: 'POST', credentials: 'include', body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload failed');
      onChange({ key: data.key, name: data.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const src = value ? `/api/block-media?key=${encodeURIComponent(value)}` : '';

  return <div className="media-field">
    <div className="label muted">{label}</div>
    {hint && <p className="muted media-hint">{hint}</p>}

    {kind === 'image' ? <div
      className={`media-drop ${dragging ? 'is-dragging' : ''} ${value ? 'has-file' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files?.[0]); }}
    >
      {value ? <img src={src} alt="Round image" /> : <span className="muted">{busy ? 'Uploading…' : 'Drop the round’s image here, or click to browse'}</span>}
    </div> : <>
      <input ref={inputRef} className="field" type="file" accept="audio/*" disabled={busy} onChange={e => void upload(e.target.files?.[0])} />
      {value && <div className="media-audio">
        <audio controls preload="none" src={src} />
        <span className="muted">{name || 'Uploaded'}</span>
      </div>}
    </>}

    {kind === 'image' && <input ref={inputRef} className="visually-hidden" type="file" accept="image/*" disabled={busy} onChange={e => void upload(e.target.files?.[0])} />}

    <div className="media-actions">
      {busy && <span className="muted">Uploading…</span>}
      {value && !busy && <button className="btn btn-secondary btn-compact" onClick={() => onChange({ key: '', name: '' })}>REMOVE</button>}
      {error && <span className="neg"><b>{error}</b></span>}
    </div>
  </div>;
}
