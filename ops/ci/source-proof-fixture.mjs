// Synthetic validation fixture only, never an admission or execution receipt.
import { createHash, randomUUID } from "node:crypto";

export function syntheticSourceProof(lane, source) {
  const digest = (label) => createHash("sha256").update(`synthetic-component:${label}`).digest("hex");
  const inventory = digest("inventory");
  const ready = { schema: "bullet.source-monitor.ack.v1", command: "READY", nonce: digest("nonce"), subject: inventory,
    sequence: 0, monitor_pid: 100, monitor_start: "200", owner_pid: 300, owner_start: "400", watch_sha256: digest("watches"), entry_count: 10 };
  return { schema: "bullet.source-proof.v1", binding: { session: randomUUID(), start_sha256: digest("start"),
    inventory_sha256: inventory, ready_sha256: createHash("sha256").update(`${JSON.stringify(ready)}\n`).digest("hex"), admission_sha256: digest("admission") },
    source, monitor_sha256: digest("monitor"), writer_release_sha256: digest("writer-release"), review_sha256: digest("review"),
    monitor_exit: 0, proof_child_exit: 0, acknowledgements: ["READY", "CHECKED", "CHECKED", "FINISHED"].map((command, sequence) => ({ ...ready, command, sequence })),
    stages: [{ generation: randomUUID(), lane, sealed_sha256: digest("sealed") }] };
}
