import { useCallback } from "react";
import { getCodingTask } from "../codingTasks";
import { useProjection } from "../hooks/useProjection";

export function CodingTaskCard({ commandId }: { commandId: string }) {
  const load = useCallback(async () => {
    const snapshot = await getCodingTask(commandId);
    return { reads: [snapshot], body: snapshot.data };
  }, [commandId]);
  const task = useProjection("Coding task", load);
  return <section className="card" aria-label="Accepted coding task">
    <h2>Accepted task</h2>
    <button type="button" onClick={task.refresh}>Refresh task</button>
    {task.kind === "loading" ? <p>Loading task…</p> : task.kind === "unknown" ?
      <p className="unknown">Task status UNKNOWN: {task.text}</p> : <>
        <h3>{task.body.task.title}</h3>
        <p>{task.body.task.objective}</p>
        <dl>
          <dt>Task revision</dt><dd>{task.body.task_revision_id}</dd>
          <dt>Run</dt><dd>{task.body.run_id}</dd>
          <dt>Repository / base</dt><dd>{task.body.task.repository_id} / {task.body.task.base_commit}</dd>
          <dt>Requested runtime</dt><dd>{task.body.selection.provider} · {task.body.selection.model} · {task.body.selection.account_id} · effort {task.body.selection.effort ?? "unspecified"}</dd>
          <dt>Command phase</dt><dd>{task.body.command.status} · verification receipt unchecked</dd>
          <dt>Observed</dt><dd>{task.observedAt} · sequence {task.asOf}</dd>
        </dl>
        <h3>Queue blockers</h3>
        {task.body.blockers.length === 0 ? <p>No blocker recorded in this snapshot.</p> :
          <ul>{task.body.blockers.map((blocker, index) => <li key={`${blocker.code}:${blocker.subject}:${index}`}>
            {blocker.code}{blocker.subject === null ? "" : ` · ${blocker.subject}`}
          </li>)}</ul>}
      </>}
  </section>;
}
