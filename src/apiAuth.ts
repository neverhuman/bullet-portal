import { API_PREFIX, PUBLIC_API_RUNTIME_REFS, type OperatorSessionView, type SessionRevocationView } from "./generated/api";
import { compileGeneratedValidator } from "./apiValidation";
import { CSRF_HEADER, csrfToken, forgetBrowserSession } from "./apiSession";
import { ApiError, readJson } from "./apiTransport";

const sessionShape = compileGeneratedValidator<OperatorSessionView>(PUBLIC_API_RUNTIME_REFS.OperatorSessionView);
const revocationShape = compileGeneratedValidator<SessionRevocationView>(PUBLIC_API_RUNTIME_REFS.SessionRevocationView);

export async function getOperatorSession(): Promise<OperatorSessionView> {
  const path = `${API_PREFIX}/auth/session`;
  const session = await readJson(path, sessionShape, { cache: "no-store" }, 200);
  const lifetime = Date.parse(session.expires_at) - Date.parse(session.issued_at);
  if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 28_800_000) {
    throw new ApiError("GET", path, 200, "session lifetime is contradictory");
  }
  return session;
}

export async function revokeOperatorSession(): Promise<SessionRevocationView> {
  const path = `${API_PREFIX}/auth/revoke`;
  const csrf = csrfToken();
  if (csrf === null) throw new ApiError("POST", path, null, "session authentication is required", false);
  const original = await getOperatorSession();
  const revoked = await readJson(path, revocationShape, {
    method: "POST", cache: "no-store",
    headers: { "content-type": "application/json", [CSRF_HEADER]: csrf },
    body: "{}",
  }, 200);
  const revokedAt = Date.parse(revoked.revoked_at);
  if (revoked.operator_id !== original.operator_id || revoked.session_id !== original.session_id ||
      !Number.isFinite(revokedAt) || revokedAt < Date.parse(original.issued_at) ||
      revokedAt >= Date.parse(original.expires_at)) {
    throw new ApiError("POST", path, 200, "revocation does not match the observed session", true);
  }
  if (csrfToken() !== csrf) {
    throw new ApiError("POST", path, 200, "local session changed during revocation; check the current session", true);
  }
  forgetBrowserSession();
  return revoked;
}
