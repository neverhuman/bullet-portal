// Portable read-only validation of the monitor artifact. This unsigned record
// is diagnostic evidence; it does not grant admission or integration authority.
import { createHash } from "node:crypto";
const sha = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const refusal = (detail) => { throw new Error(`CI_SOURCE_PROOF_INVALID: ${detail}`); };

export const sourceProofPath = (lane) => `.ci-artifacts/reports/${lane}-source-proof.json`;

export function validateSourceProof(proof, lane, source, requireSuccess = false) {
  if (!keys(proof, ["schema", "binding", "source", "monitor_sha256", "writer_release_sha256", "review_sha256", "monitor_exit", "proof_child_exit", "acknowledgements", "stages"])
      || proof.schema !== "bullet.source-proof.v1" || proof.monitor_exit !== 0
      || !Number.isSafeInteger(proof.proof_child_exit) || proof.proof_child_exit < 0 || proof.proof_child_exit > 255
      || (requireSuccess && proof.proof_child_exit !== 0)
      || !keys(proof.source, ["commit_oid", "tree_oid"])
      || proof.source.commit_oid !== source.commit_oid || proof.source.tree_oid !== source.tree_oid
      || ![proof.monitor_sha256, proof.writer_release_sha256, proof.review_sha256].every((value) => sha.test(value ?? ""))) refusal("completion/source");
  const binding = proof.binding;
  if (!keys(binding, ["session", "start_sha256", "inventory_sha256", "ready_sha256", "admission_sha256"])
      || !uuid.test(binding.session ?? "")
      || ![binding.start_sha256, binding.inventory_sha256, binding.ready_sha256, binding.admission_sha256].every((value) => sha.test(value ?? ""))) refusal("binding");
  const acks = proof.acknowledgements;
  if (!Array.isArray(acks) || acks.length < 4 || acks.length > 10000) refusal("acknowledgement inventory");
  if (createHash("sha256").update(`${JSON.stringify(acks[0])}\n`).digest("hex") !== binding.ready_sha256) refusal("READY bytes");
  const fixed = ["schema", "nonce", "subject", "monitor_pid", "monitor_start", "owner_pid", "owner_start", "watch_sha256", "entry_count"];
  for (const [sequence, ack] of acks.entries()) {
    const command = sequence === 0 ? "READY" : sequence === acks.length - 1 ? "FINISHED" : "CHECKED";
    if (!keys(ack, [...fixed, "command", "sequence"])
        || ack.schema !== "bullet.source-monitor.ack.v1" || ack.command !== command || ack.sequence !== sequence
        || ![ack.nonce, ack.subject, ack.watch_sha256].every((value) => sha.test(value ?? ""))
        || ack.subject !== binding.inventory_sha256 || !positive(ack.entry_count)
        || !positive(ack.monitor_pid) || !positive(ack.owner_pid)
        || !/^[1-9][0-9]*$/.test(ack.monitor_start ?? "") || !/^[1-9][0-9]*$/.test(ack.owner_start ?? "")
        || fixed.some((field) => ack[field] !== acks[0][field])) refusal("acknowledgement subject/order");
  }
  if (!Array.isArray(proof.stages) || proof.stages.length < 1 || proof.stages.length > 100) refusal("stage inventory");
  const lanes = new Set(); const generations = new Set();
  for (const stage of proof.stages) {
    if (!keys(stage, ["generation", "lane", "sealed_sha256"]) || !uuid.test(stage.generation ?? "")
        || !/^[a-z][a-z0-9-]*$/.test(stage.lane ?? "") || !sha.test(stage.sealed_sha256 ?? "")
        || lanes.has(stage.lane) || generations.has(stage.generation)) refusal("stage binding");
    lanes.add(stage.lane); generations.add(stage.generation);
  }
  if (!lanes.has(lane)) refusal("selected lane absent");
  return proof;
}
