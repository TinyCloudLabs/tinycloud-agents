import { useState } from "react";

export function Copyable({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="row">
      <code className="mono">{label ?? text}</code>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
