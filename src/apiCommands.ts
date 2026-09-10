import { API_PREFIX, PUBLIC_API_RUNTIME_REFS, type CommandDiscoveryView } from "./generated/api";
import { ApiError, readSnapshot, type SnapshotRead } from "./apiTransport";
import { compileGeneratedValidator, isCommandStatus } from "./apiValidation";

const validatesDiscovery = compileGeneratedValidator<CommandDiscoveryView>(
  PUBLIC_API_RUNTIME_REFS.CommandDiscoveryView,
);

function isDiscovery(value: unknown): value is CommandDiscoveryView {
  return validatesDiscovery(value) && value.commands.every(isCommandStatus) &&
    new Set(value.commands.map((command) => command.id)).size === value.commands.length;
}

/** Discover durable commands owned by the authenticated operator, including after cache loss. */
export async function listCommands(after = 0, limit = 25): Promise<SnapshotRead<CommandDiscoveryView>> {
  const path = `${API_PREFIX}/commands`;
  if (!Number.isSafeInteger(after) || after < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError("GET", path, null, "invalid command discovery cursor or page limit");
  }
  const query = new URLSearchParams({ after: String(after), limit: String(limit) });
  const snapshot = await readSnapshot(`${path}?${query.toString()}`, isDiscovery);
  const { commands, next_after: next } = snapshot.data;
  if (snapshot.asOfSequence < after || commands.length > limit ||
      (next !== null && (commands.length === 0 || next <= after || next > snapshot.asOfSequence))) {
    throw new ApiError("GET", path, 200, "command discovery cursor contradicts its snapshot");
  }
  return snapshot;
}
