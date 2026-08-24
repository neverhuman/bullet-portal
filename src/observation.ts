import type { ObservationKind } from "./generated/api";

export type ObservationView = {
  kind: ObservationKind;
  text: string;
};

export function renderObservation(obs: ObservationView): string {
  if (obs.kind === "unknown") {
    return `unknown: ${obs.text}`;
  }
  if (obs.kind === "contradictory") {
    return `contradictory: ${obs.text}`;
  }
  if (obs.kind === "empty") {
    return "empty";
  }
  return obs.text;
}

export function isHealthy(obs: ObservationView): boolean {
  return obs.kind === "value";
}
