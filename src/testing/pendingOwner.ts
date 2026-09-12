import { vi } from "vitest";
import { getOperatorSession } from "../apiAuth";
import { browserSessionEpoch, csrfToken, rememberCsrfToken } from "../apiSession";
import * as pending from "../pendingCommand";

export const identity = { operator_id: `opr_${"1".repeat(64)}`, session_id: `sid_${"2".repeat(64)}` };
export const ownerFixture = () => ({ origin: window.location.origin, operatorId: identity.operator_id,
  sessionId: identity.session_id, epoch: browserSessionEpoch(), csrf: csrfToken() });
export const pendingSlot = () => `bullet-farm.pending-command.v2:${JSON.stringify([window.location.origin, identity.operator_id])}`;
export function setupOwner(): void {
  rememberCsrfToken("fixture-csrf");
  vi.mocked(getOperatorSession).mockResolvedValue({ status: "AUTHENTICATED", ...identity,
    issued_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T08:00:00Z" });
}
// Existing custody assertions use the same explicit nonsecret operator fixture.
export const clearPendingCommand = () => sessionStorage.clear();
export const loadPendingCommand = () => pending.loadPendingCommand(ownerFixture());
export const persistPendingCommand = (record: pending.PendingCommand) => pending.persistPendingCommand(record, ownerFixture());
export const envelopeForRetryOrCreate = (create: Parameters<typeof pending.envelopeForRetryOrCreate>[0]) =>
  pending.envelopeForRetryOrCreate(create, ownerFixture());
export const rememberAdmittedCommand = (subject: pending.AdmittedSubject, envelope: pending.PendingCommand["envelope"]) =>
  pending.rememberAdmittedCommand(subject, envelope, ownerFixture());
export const clearPendingCommandIf = (subject: pending.AdmittedSubject, envelope: pending.PendingCommand["envelope"]) =>
  pending.clearPendingCommandIf(subject, envelope, ownerFixture());
export const pendingConflicts = (scope: Parameters<typeof pending.pendingConflicts>[0]) => pending.pendingConflicts(scope, ownerFixture());
export { restoredSubjectConflicts } from "../pendingCommand";
