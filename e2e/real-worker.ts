import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getgid, getuid } from "node:process";
import { promisify } from "node:util";
import { blake3 } from "@noble/hashes/blake3.js";

import { expect } from "@playwright/test";
import type { CommandStatus } from "../src/generated/api";

const environment = process.env;

// COMPONENT_PROOF only. Workload custody never enters browser JavaScript.
export async function reconcileComponent(
  commandId: string, pending: CommandStatus,
  readCommand: () => Promise<{ status: number; body: CommandStatus }>,
): Promise<void> {
    // Fixture execution stays in Node. The browser never receives workload custody.
    const binary = environment?.BULLET_COMPONENT_WORKER_BIN;
    const proof = environment?.BULLET_COMPONENT_PROOF_DIR;
    const reports = environment?.BULLET_COMPONENT_REPORT_DIR;
    const supervisor = environment?.BULLET_COMPONENT_SUPERVISOR;
    expect(binary).toMatch(/^\//);
    expect(proof).toMatch(/^\//);
    expect(reports).toMatch(/^\//);
    expect(supervisor).toMatch(/^\//);
    if (!binary || !proof || !reports || !supervisor) throw new Error("real component worker fixture required");
    if (!getuid || !getgid) throw new Error("Linux workload fixture required");
    const args = [
      "--lease-socket", join(proof, "socket/lease.sock"),
      "--farmd-uid", String(getuid()), "--socket-gid", String(getgid()),
      "--runner-id", `run_${"1".repeat(64)}`, "--runner-epoch", "1",
      "--state-dir", join(proof, "worker"), "--binary-manifest", join(proof, "binaries.json"),
      "--deadline-ms", "600000",
    ];
    const runWorker = async (label: string, seconds: string) => {
      try {
        const output = await promisify(execFile)("/usr/bin/python3",
          [supervisor, "--timeout-seconds", seconds, "--", binary, ...args],
          { env: { PATH: "/usr/bin:/bin" }, maxBuffer: 1024 * 1024 });
        await writeFile(join(reports, `component-worker-${label}.stdout`), output.stdout);
        await writeFile(join(reports, `component-worker-${label}.stderr`), output.stderr);
        expect(output.stderr).toBe("");
        return output.stdout;
      } catch (error) {
        await writeFile(join(reports, `component-worker-${label}.failure`), String(error));
        throw error;
      }
    };
    expect(await runWorker("first", "700")).toBe("COMMAND_UNKNOWN\n");
    const stateBytes = await readFile(join(proof, "worker/current.json"));
    const state = JSON.parse(stateBytes.toString());
    expect(state.stage).toBe("SETTLED_UNKNOWN");
    expect(state.claim).toMatchObject({ command_id: commandId, request_digest: pending.payload_digest });
    expect(state.claim.claim_id).toMatch(/^dcl_[0-9a-f]{64}$/);
    const receiptBytes = await readFile(join(proof, "worker", state.claim.claim_id, "run/COMPONENT_PROOF.receipt.json"));
    const receiptDigest = Buffer.from(blake3(receiptBytes)).toString("hex");
    expect(state.receipt_sha256).toBe(createHash("sha256").update(receiptBytes).digest("hex"));
    expect(state.receipt_digest).toBe(receiptDigest);
    const manifest = await readFile(join(proof, "binaries.json"));
    expect(state.binary_manifest_sha256).toBe(createHash("sha256").update(manifest).digest("hex"));
    const receipt = JSON.parse(receiptBytes.toString());
    expect(receipt).toMatchObject({
      evidence_class: "COMPONENT_PROOF", signing_trust: "UNSIGNED_FIXTURE",
      transaction_gate_eligible: false, independent_evidence_eligible: false,
      command_dispatch: {
        source: "SEALED_CLAIM", command_id: commandId, request_digest: pending.payload_digest,
        binary_manifest_sha256: state.binary_manifest_sha256,
      },
    });
    await writeFile(join(reports, "component-worker-state.json"), stateBytes);
    await writeFile(join(reports, "component-worker-receipt.json"), receiptBytes);
    const reconciled = await readCommand();
    expect(reconciled.status).toBe(200);
    const settled = reconciled.body;
    expect(settled.id).toBe(commandId);
    expect(settled.status).toBe("UNKNOWN");
    expect(settled.result).toMatchObject({
      command_id: commandId,
      request_digest: pending.payload_digest,
      receipt_digest: receiptDigest,
      code: "COMPONENT_PROOF_NOT_TRANSACTION_ELIGIBLE",
      evidence_class: "COMPONENT_PROOF", signing_trust: "UNSIGNED_FIXTURE",
      transaction_gate_eligible: false, independent_evidence_eligible: false,
    });
    expect(settled.payload_digest).toBe(pending.payload_digest);
    expect(await runWorker("restart", "30")).toBe("NO_COMMAND\n");
    expect(await readFile(join(proof, "worker/current.json"))).toEqual(stateBytes);
    const replay = await readCommand();
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(settled);
    await writeFile(join(reports, "component-command-result.json"), JSON.stringify(settled));
}
