import { useEffect, useState } from "react";
import { signIn, type Session } from "./tinycloud";
import { signerFromTcw, type Signer, type Agent, listAgents, createAgent } from "./api";
import { randomAgentName } from "./names";
import { AgentCard } from "./components/AgentCard";
import { Copyable } from "./components/Copyable";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setSigningIn(true);
    setError(null);
    try {
      setSession(await signIn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>TinyCloud Agents</h1>
        <p>Create agents, delegate access to your TinyCloud memory space, and chat.</p>
      </header>

      {!session ? (
        <div className="card">
          <button className="primary" disabled={signingIn} onClick={handleSignIn}>
            {signingIn ? "Signing in…" : "Sign in with passkey"}
          </button>
          {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
        </div>
      ) : (
        <Dashboard session={session} />
      )}
    </div>
  );
}

function Dashboard({ session }: { session: Session }) {
  const signer: Signer = signerFromTcw(session.tcw);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  // Prefill with a friendly suggestion; the user can edit or replace it.
  const [name, setName] = useState(randomAgentName);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAgents(signer)
      .then((list) => {
        if (!cancelled) setAgents(list);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // signer is derived per-render but stable for a session; list once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const agent = await createAgent(signer, name.trim() || undefined);
      setAgents((a) => [...a, agent]);
      setName(randomAgentName());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  function updateAgent(updated: Agent) {
    setAgents((list) => list.map((a) => (a.agentId === updated.agentId ? updated : a)));
  }

  return (
    <>
      <div className="card">
        <div className="spread">
          <span className="muted">Signed in</span>
        </div>
        <div className="field" style={{ marginTop: 4 }}>
          <label>Your DID</label>
          <Copyable text={session.did} />
        </div>
      </div>

      <div className="card">
        <div className="field">
          <label>Agent name (optional)</label>
          <div className="row">
            <input
              value={name}
              placeholder="e.g. Research assistant"
              disabled={creating}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
            <button className="primary" disabled={creating} onClick={create}>
              {creating ? "Creating…" : "Create agent"}
            </button>
          </div>
        </div>
        {error && <div className="error">{error}</div>}
      </div>

      {loading ? (
        <div className="muted">Loading agents…</div>
      ) : agents.length === 0 ? (
        <div className="muted">No agents yet. Create one above.</div>
      ) : (
        agents.map((agent) => (
          <AgentCard
            key={agent.agentId}
            tcw={session.tcw}
            signer={signer}
            agent={agent}
            onChange={updateAgent}
          />
        ))
      )}
    </>
  );
}
