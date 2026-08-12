/**
 * The reading surface: the document, with the spoken word highlighted, the
 * current sentence lightly shaded, tap-to-seek on every word, and auto-scroll
 * that keeps the active line in view without fighting the user.
 *
 * Performance note: a chapter is easily 5,000 words, and re-rendering 5,000
 * spans 3 times a second would drop frames on a phone. So the document is
 * split into paragraphs and each paragraph is memoised on "does it contain the
 * active word / the active sentence". A word change therefore re-renders at
 * most two paragraphs — the one being left and the one being entered.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Token, Tokenized } from '../lib/text/tokenize';

interface Paragraph {
  firstToken: number;
  lastToken: number;
}

/** Group tokens into paragraphs using the blank lines in the source text. */
function paragraphize(doc: Tokenized): Paragraph[] {
  const { tokens, text } = doc;
  if (!tokens.length) return [];
  const paragraphs: Paragraph[] = [];
  let first = 0;
  for (let i = 0; i < tokens.length - 1; i++) {
    const gap = text.slice(tokens[i].end, tokens[i + 1].start);
    if (/\n[ \t]*\n/.test(gap)) {
      paragraphs.push({ firstToken: first, lastToken: i });
      first = i + 1;
    }
  }
  paragraphs.push({ firstToken: first, lastToken: tokens.length - 1 });
  return paragraphs;
}

interface ParagraphProps {
  tokens: Token[];
  text: string;
  firstToken: number;
  lastToken: number;
  /** -1 when the active word is not in this paragraph. */
  activeToken: number;
  activeSentence: number;
  onSeek: (tokenIndex: number) => void;
}

const ParagraphView = memo(function ParagraphView({
  tokens,
  text,
  firstToken,
  lastToken,
  activeToken,
  activeSentence,
  onSeek,
}: ParagraphProps) {
  // Words are grouped inside a per-sentence wrapper so the sentence shading is
  // one continuous band (including the spaces between words) rather than a row
  // of separate boxes — and so the active word's own highlight sits on a child
  // element, where it can't be overridden by the sentence background.
  const groups: React.ReactNode[] = [];
  let cursor = firstToken;

  while (cursor <= lastToken) {
    const sentence = tokens[cursor].sentence;
    let last = cursor;
    while (last + 1 <= lastToken && tokens[last + 1].sentence === sentence) last++;

    const words: React.ReactNode[] = [];
    for (let i = cursor; i <= last; i++) {
      const token = tokens[i];
      words.push(
        <span
          key={i}
          // The id is how auto-scroll finds the active word.
          id={i === activeToken ? 'active-word' : undefined}
          onClick={() => onSeek(i)}
          className={`tok cursor-pointer${i === activeToken ? ' tok-active' : ''}`}
        >
          {token.text}
        </span>,
      );
      // Reproduce the gap to the next word: a single newline inside a paragraph
      // (verse, an address, cleanup switched off) is kept as a line break.
      if (i < last) {
        const gap = text.slice(token.end, tokens[i + 1].start);
        words.push(gap.includes('\n') ? <br key={`b${i}`} /> : ' ');
      }
    }

    groups.push(
      <span key={cursor} className={sentence === activeSentence ? 'sent-active' : undefined}>
        {words}
      </span>,
    );

    // Separator between sentences, taken from the source text.
    if (last < lastToken) {
      const gap = text.slice(tokens[last].end, tokens[last + 1].start);
      groups.push(gap.includes('\n') ? <br key={`sb${last}`} /> : ' ');
    }
    cursor = last + 1;
  }

  return <p className="mb-5">{groups}</p>;
});

interface Props {
  doc: Tokenized;
  activeToken: number;
  activeSentence: number;
  onSeek: (tokenIndex: number) => void;
  /** Font size in px for the reading surface. */
  fontSize: number;
  playing: boolean;
}

/** How long to leave auto-scroll off after the user scrolls by hand. */
const MANUAL_SCROLL_GRACE_MS = 6000;

export function Reader({
  doc,
  activeToken,
  activeSentence,
  onSeek,
  fontSize,
  playing,
}: Props) {
  const paragraphs = useMemo(() => paragraphize(doc), [doc]);
  const lastManualScroll = useRef(0);
  const [following, setFollowing] = useState(true);

  // Treat a wheel/touch gesture as "let me read where I want for a bit".
  useEffect(() => {
    const onManual = () => {
      lastManualScroll.current = performance.now();
      setFollowing(false);
    };
    window.addEventListener('wheel', onManual, { passive: true });
    window.addEventListener('touchmove', onManual, { passive: true });
    return () => {
      window.removeEventListener('wheel', onManual);
      window.removeEventListener('touchmove', onManual);
    };
  }, []);

  // Auto-scroll: only when the active word has drifted out of a comfortable
  // band in the middle of the screen, so the page doesn't twitch on every word.
  useEffect(() => {
    if (!playing) return;
    if (!following && performance.now() - lastManualScroll.current < MANUAL_SCROLL_GRACE_MS)
      return;
    if (!following) setFollowing(true);

    const el = document.getElementById('active-word');
    if (!el) return;

    const { top, bottom } = el.getBoundingClientRect();
    const viewport = window.innerHeight;
    const comfortableTop = viewport * 0.2;
    const comfortableBottom = viewport * 0.62;

    if (top < comfortableTop || bottom > comfortableBottom) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeToken, playing, following]);

  return (
    <div className="relative">
      <article
        className="font-reader leading-[1.75] text-ink"
        style={{ fontSize }}
        // Selecting text is what a mouse drag should do; tapping seeks.
      >
        {paragraphs.map((p) => (
          <ParagraphView
            key={p.firstToken}
            tokens={doc.tokens}
            text={doc.text}
            firstToken={p.firstToken}
            lastToken={p.lastToken}
            activeToken={
              activeToken >= p.firstToken && activeToken <= p.lastToken ? activeToken : -1
            }
            activeSentence={
              doc.tokens[p.firstToken].sentence <= activeSentence &&
              doc.tokens[p.lastToken].sentence >= activeSentence
                ? activeSentence
                : -1
            }
            onSeek={onSeek}
          />
        ))}
      </article>

      {!following && playing && (
        <button
          onClick={() => {
            setFollowing(true);
            lastManualScroll.current = 0;
            document
              .getElementById('active-word')
              ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }}
          className="fixed bottom-32 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-surface px-4 py-2 text-xs font-medium shadow-lg"
        >
          Jump to the spoken word
        </button>
      )}
    </div>
  );
}
