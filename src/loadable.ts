export type Loadable<T> =
  | { kind: "loading" }
  | { kind: "value"; value: T; observedAt: string }
  | { kind: "unknown"; reason: string; observedAt: string };

export function toValue<T>(value: T): Loadable<T> {
  return { kind: "value", value, observedAt: new Date().toISOString() };
}

export function toUnknown<T>(reason: string): Loadable<T> {
  return { kind: "unknown", reason, observedAt: new Date().toISOString() };
}
