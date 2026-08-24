export type Loadable<T> =
  | { kind: "loading" }
  | { kind: "value"; value: T; observedAt: string; source: string }
  | { kind: "unknown"; reason: string; observedAt: string; source: "portal/local" };

export function toValue<T>(value: T): Loadable<T> {
  return { kind: "value", value, observedAt: new Date().toISOString(), source: "portal/local" };
}

export function toSnapshotValue<T>(
  value: T,
  observedAt: string,
  source: string,
): Loadable<T> {
  return { kind: "value", value, observedAt, source };
}

export function toUnknown<T>(reason: string): Loadable<T> {
  return {
    kind: "unknown",
    reason,
    observedAt: new Date().toISOString(),
    source: "portal/local",
  };
}
