"use client";

import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

let mermaidInit = false;

export function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 9)}`);

  useEffect(() => {
    if (!mermaidInit) {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: {
          primaryColor: '#6c5ce7',
          primaryTextColor: '#e4e4ec',
          primaryBorderColor: '#4a3db5',
          lineColor: '#666680',
          secondaryColor: '#1a1a24',
          tertiaryColor: '#12121a',
        },
        sequence: {
          mirrorActors: false,
          bottomMarginAdj: 1,
        },
      });
      mermaidInit = true;
    }

    if (!containerRef.current) return;

    mermaid
      .render(idRef.current, chart)
      .then(({ svg }) => {
        if (containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
        setError(null);
      })
      .catch((err) => {
        setError(String(err));
      });
  }, [chart]);

  if (error) {
    return (
      <div className="text-xs text-ax-error bg-ax-error/10 rounded p-2">
        Mermaid error: {error}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex justify-center overflow-x-auto"
    />
  );
}
