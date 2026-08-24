import type { DemoReceipt, Mission } from "./generated/api";

const base = "";

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export function listMissions(): Promise<Mission[]> {
  return readJson("/v1/missions");
}

export function runDemo(): Promise<DemoReceipt> {
  return readJson("/v1/demo/run", { method: "POST" });
}
