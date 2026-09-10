import { prepareCommand } from "../commandIdentity";
import type { CommandStatus } from "../generated/api";

export const codingPayload = {
  account_id: "acct-local", provider: "claude", model: "claude-opus-4-6",
  expected_revision: 1, launch_nonce: "aa".repeat(32),
  quota_reservation: `rsv_${"bb".repeat(32)}`, quota_units: 1,
  allocated_run: `run_${"cc".repeat(32)}`,
};

export function pendingRecord(key = "portal_fixture", id?: string | null) {
  const envelope = { idempotency_key: key, kind: "run_coding", payload: codingPayload };
  const subject = prepareCommand(envelope).subject;
  return { envelope, commandId: id === null ? null : id ?? subject.id,
    kind: subject.kind, payloadDigest: id === null ? null : subject.payload_digest };
}

export const commandId = pendingRecord().commandId!;
export const digest = pendingRecord().payloadDigest!;

export function command(status: CommandStatus["status"], result: CommandStatus["result"] = null): CommandStatus {
  return { id: commandId, status, kind: "run_coding", payload_digest: digest, result };
}
