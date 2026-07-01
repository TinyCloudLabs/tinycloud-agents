import { useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { Agent, DelegationStatus, Signer } from "../api";
import { setEnabled as apiSetEnabled } from "../api";
import { delegateAgent } from "../delegate";
import { Copyable } from "./Copyable";
import { Chat } from "./Chat";
import { ToolPanel } from "./ToolPanel";

const STATUS_LABEL: Record<DelegationStatus, string> = {
  active: "Delegation active",
  expired: "Delegation expired",
  stale: "Delegation stale",
  none: "Not delegated",
};

export function AgentCard({
  tcw,
  signer,
  agent,
  onChange,
}: {
  tcw: TinyCloudWeb;
  signer: Signer;
  agent: Agent;
  onChange: (agent: Agent) => void;
}) {
  const [delegating, setDelegating] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status: DelegationStatus = agent.delegationStatus ?? "none";

  async function delegate() {
    setDelegating(true);
    setError(null);
    try {
      const status = await delegateAgent(tcw, signer, agent);
      onChange({ ...agent, delegationStatus: status ?? "active" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDelegating(false);
    }
  }

  async function toggle() {
    setToggling(true);
    setError(null);
    try {
      const updated = await apiSetEnabled(signer, agent.agentId, !agent.enabled);
      onChange({ ...agent, enabled: updated.enabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(false);
    }
  }

  const promptRedelegate = () => onChange({ ...agent, delegationStatus: "none" });

  return (
    <div className="card">
      <div className="spread">
        <strong>{agent.name || "Untitled agent"}</strong>
        <span className={`badge ${status}`}>{STATUS_LABEL[status]}</span>
      </div>

      <div className="field" style={{ marginTop: 8 }}>
        <label>Agent DID</label>
        <Copyable text={agent.agentDid} />
      </div>

      <div className="row" style={{ margin: "12px 0" }}>
        <button className="primary" disabled={delegating} onClick={delegate}>
          {delegating ? "Delegating…" : status === "active" ? "Re-delegate" : "Delegate"}
        </button>
        <button disabled={toggling} onClick={toggle}>
          {agent.enabled ? "Disable" : "Enable"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "12px 0" }} />
      <Chat
        signer={signer}
        agentId={agent.agentId}
        disabled={!agent.enabled}
        onDelegationRequired={promptRedelegate}
      />

      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "12px 0" }} />
      <ToolPanel
        signer={signer}
        agentId={agent.agentId}
        disabled={!agent.enabled}
        onDelegationRequired={promptRedelegate}
      />
    </div>
  );
}
