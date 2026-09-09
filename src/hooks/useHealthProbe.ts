import { useCallback, useEffect, useState } from "react";
import { errorText, fetchHealth } from "../api";
import type { Loadable } from "../loadable";
import { toUnknown, toValue } from "../loadable";

const REPROBE_MS = 30_000;

export type HealthProbe = {
  state: Loadable<string>;
  refresh: () => void;
};

export function useHealthProbe(): HealthProbe {
  const [state, setState] = useState<Loadable<string>>({ kind: "loading" });

  const refresh = useCallback(() => {
    fetchHealth()
      .then((health) => setState(toValue(health.status)))
      .catch((err: unknown) => setState(toUnknown(errorText(err))));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REPROBE_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return { state, refresh };
}
