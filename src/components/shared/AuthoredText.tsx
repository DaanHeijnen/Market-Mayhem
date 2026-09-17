import { toParagraphs } from '../../lib/authored-text';

/**
 * Text the host wrote, shown the way they wrote it.
 *
 * Plain text in, plain text out: every paragraph is rendered as React children, so there
 * is no route by which something typed into an Admin field becomes markup. No
 * `dangerouslySetInnerHTML`, and none is needed — the structure comes from real `<p>`
 * elements plus `white-space: pre-wrap` for the line breaks inside them, not from HTML in
 * the content.
 *
 * Renders nothing at all when there is nothing to say, so callers do not each need their
 * own `{text && …}` guard.
 */
export function AuthoredText({ text, className = '' }: { text: unknown; className?: string }) {
  const paragraphs = toParagraphs(text);
  if (!paragraphs.length) return null;
  return <div className={`authored-text ${className}`.trim()}>
    {paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
  </div>;
}
