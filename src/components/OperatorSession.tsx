import { useRef, useState } from "react";
import { errorText, exchangeBootstrap, forgetBrowserSession, hasSessionMaterial } from "../api";
import { getOperatorSession, revokeOperatorSession } from "../apiAuth";
import type { OperatorSessionView } from "../generated/api";

export function OperatorSession({ material, onChange }: { material: boolean; onChange: (material: boolean) => void }) {
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<OperatorSessionView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const busy = useRef(false);

  async function perform(action: "login" | "status" | "revoke"): Promise<void> {
    if (busy.current || (action === "login" && token.trim() === "")) return;
    busy.current = true; setPending(true); setError(null); setMessage(null);
    try {
      if (action === "login") {
        await exchangeBootstrap(token.trim());
        setToken(""); setSession(null); onChange(true);
      } else if (action === "status") {
        setSession(await getOperatorSession());
      } else {
        const revoked = await revokeOperatorSession();
        setSession(null); onChange(hasSessionMaterial());
        setMessage(`REVOKED: session ${revoked.session_id}. Durable work continues.`);
      }
    } catch (err) {
      setSession(null);
      setError(errorText(err));
    } finally {
      busy.current = false; setPending(false);
    }
  }

  return <section className="card" aria-labelledby="operator-session-title">
    <h2 id="operator-session-title">Operator session</h2>
    {material ? <p className="pending" data-testid="auth-state">local session material present; farmd revalidates every command</p> :
      <form onSubmit={(event) => { event.preventDefault(); void perform("login"); }}>
        <label htmlFor="bootstrap-token">One-time bootstrap token</label>{" "}
        <input id="bootstrap-token" type="password" autoComplete="off" value={token}
          onChange={(event) => setToken(event.target.value)} disabled={pending} />{" "}
        <button type="submit" disabled={pending || token.trim() === ""}>Authenticate local session</button>
      </form>}
    <button type="button" disabled={pending} onClick={() => void perform("status")}>Check session</button>{" "}
    <button type="button" disabled={pending || !material} onClick={() => void perform("revoke")}>Revoke this session</button>
    {material && <button type="button" disabled={pending} onClick={() => {
      forgetBrowserSession(); setSession(null); setError(null); onChange(false);
      setMessage("Local credentials forgotten. Server authority was not revoked; durable work and request journals remain.");
    }}>Forget local credentials (does not revoke)</button>}
    {session !== null && <p data-testid="operator-session-identity">
      AUTHENTICATED · operator {session.operator_id} · session {session.session_id} · expires {session.expires_at}
    </p>}
    {message !== null && <p role="status">{message}</p>}
    {error !== null && <p className="unknown" role="alert" data-testid="auth-error">Session observation UNKNOWN: {error}</p>}
  </section>;
}
