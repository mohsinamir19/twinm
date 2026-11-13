"use client";

import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  content: string;
  streaming?: boolean;
  onDone?: () => void;
}

/** Reveals markdown progressively (finishes in at most ~2.4s, however long the reply). */
function StreamedMarkdown({ content, streaming, onDone }: Props) {
  const [shown, setShown] = useState(streaming ? 0 : content.length);

  useEffect(() => {
    if (!streaming) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setShown(content.length);
      onDone?.();
      return;
    }
    const perFrame = Math.max(2, Math.ceil(content.length / 140));
    let n = 0;
    let raf = 0;
    const tick = () => {
      n = Math.min(content.length, n + perFrame);
      setShown(n);
      if (n < content.length) raf = requestAnimationFrame(tick);
      else onDone?.();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, content]);

  return (
    <div className="prose-twin">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content.slice(0, shown)}</ReactMarkdown>
    </div>
  );
}

export default memo(StreamedMarkdown);
