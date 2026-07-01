import { useState } from "react";
import type { Signer } from "../api";
import { callTool, DelegationRequiredError } from "../api";

// The only tool the service exposes today is `web_search` (Tavily).
export function ToolPanel({
  signer,
  agentId,
  disabled,
  onDelegationRequired,
}: {
  signer: Signer;
  agentId: string;
  disabled: boolean;
  onDelegationRequired: () => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await callTool(signer, agentId, "web_search", { query: q });
      setResult(JSON.stringify(res, null, 2));
    } catch (err) {
      if (err instanceof DelegationRequiredError) {
        onDelegationRequired();
        setError("Delegation required — re-delegate to use tools.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="muted" style={{ marginBottom: 6 }}>web_search</div>
      <div className="row">
        <input
          value={query}
          placeholder="Search query…"
          disabled={disabled || busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
        />
        <button disabled={disabled || busy} onClick={run}>
          Search
        </button>
      </div>
      {error && <div className="error" style={{ marginTop: 6 }}>{error}</div>}
      {result && <pre className="tool-result" style={{ marginTop: 8 }}>{result}</pre>}
    </div>
  );
}
