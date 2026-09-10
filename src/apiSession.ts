const CSRF_STORAGE_SLOT = "bullet-farm.csrf.v1";

let csrfInMemory: string | null = null;
let epoch = 0;
const listeners = new Set<() => void>();

export const browserSessionEpoch = (): number => epoch;
export function onBrowserSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function changed(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

export const CSRF_HEADER = "x-bullet-csrf";

function browserStorage(): Storage | null {
  try {
    // jankurai:allow websec.storage.token reason=CSRF double-submit nonce must be JS-readable; farmd session cookie stays HttpOnly Secure SameSite owner=web expires=2027-03-08
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function storedCsrfToken(): string | null {
  try {
    return browserStorage()?.getItem(CSRF_STORAGE_SLOT) ?? null;
  } catch {
    return null;
  }
}

export function csrfToken(): string | null {
  return csrfInMemory ?? storedCsrfToken();
}

export function hasSessionMaterial(): boolean {
  return csrfToken() !== null;
}

export function forgetBrowserSession(): void {
  csrfInMemory = null;
  try {
    browserStorage()?.removeItem(CSRF_STORAGE_SLOT);
  } catch {
    // In-memory authority is already cleared; unavailable storage fails closed.
  }
  changed();
}

export function rememberCsrfToken(csrf: string): void {
  csrfInMemory = csrf;
  try {
    browserStorage()?.setItem(CSRF_STORAGE_SLOT, csrf);
  } catch {
    // The current page can still use the in-memory token; reload will fail closed.
  }
  changed();
}
