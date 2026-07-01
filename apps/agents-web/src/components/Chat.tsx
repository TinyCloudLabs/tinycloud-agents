import { useRef, useState } from "react";
import type { Signer } from "../api";
import { sendMessage, DelegationRequiredError } from "../api";

interface Msg {
  who: "user" | "agent";
  text: string;
}

export function Chat({
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
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Stable conversation room for this chat session.
  const roomId = useRef(crypto.randomUUID()).current;

  const scrollDown = () => {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  };

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    setMsgs((m) => [...m, { who: "user", text }, { who: "agent", text: "" }]);
    scrollDown();
    setBusy(true);
    try {
      await sendMessage(
        signer,
        agentId,
        text,
        (delta) => {
          setMsgs((m) => {
            const next = [...m];
            next[next.length - 1] = {
              who: "agent",
              text: next[next.length - 1].text + delta,
            };
            return next;
          });
          scrollDown();
        },
        roomId
      );
    } catch (err) {
      if (err instanceof DelegationRequiredError) {
        onDelegationRequired();
        setError("Delegation required — re-delegate to chat.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="chat" ref={scrollRef}>
        {msgs.length === 0 && <div className="muted">No messages yet.</div>}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.who}`}>
            <div className="who">{m.who}</div>
            <div>{m.text || (busy && i === msgs.length - 1 ? "…" : "")}</div>
          </div>
        ))}
      </div>
      <div className="row">
        <input
          value={input}
          placeholder={disabled ? "Agent disabled" : "Message the agent…"}
          disabled={disabled || busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button className="primary" disabled={disabled || busy} onClick={send}>
          Send
        </button>
      </div>
      {error && <div className="error" style={{ marginTop: 6 }}>{error}</div>}
    </div>
  );
}
