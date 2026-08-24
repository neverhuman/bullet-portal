import type { CommandStatus } from "../generated/api";

const STATUS_CLASS: Record<CommandStatus["status"], string> = {
  PENDING: "pending",
  APPLIED: "pending",
  VERIFIED: "verified",
  FAILED: "failed",
  UNKNOWN: "unknown",
};

export function CommandCard({ command }: { command: CommandStatus }) {
  return (
    <section className="card" data-testid="command">
      <h2>Durable command</h2>
      <dl>
        <dt>Command</dt>
        <dd data-testid="command-id">{command.id}</dd>
        <dt>Status</dt>
        <dd className={STATUS_CLASS[command.status]}>{command.status}</dd>
        <dt>Kind</dt>
        <dd>{command.kind}</dd>
        <dt>Payload digest</dt>
        <dd>{command.payload_digest}</dd>
        <dt>Result</dt>
        <dd>{command.result === null ? "not recorded" : JSON.stringify(command.result)}</dd>
      </dl>
    </section>
  );
}
