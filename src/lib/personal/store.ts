import {
  PERSONAL_STATE_KEY,
  emptyPersonalState,
  parsePersonalState,
  type PersonalState,
} from "@/lib/personal/local-store";

/**
 * Personal data as an EXTERNAL STORE.
 *
 * `localStorage` is not React state: it exists before the first render, it can be
 * changed by another tab, and it can refuse a write. `useSyncExternalStore` is the
 * supported way to read a system like that, and it also removes a hydration
 * hazard — the server paints the empty snapshot, the client reads the real one and
 * re-renders, with no mismatch and no `setState` inside an effect.
 *
 * TWO FAILURE MODES, BOTH REPORTED
 *   A READ failure (storage disabled) leaves the in-memory state empty.
 *   A WRITE failure (quota, private mode) leaves the change in memory and returns
 *   a message, so a panel can say plainly that the save did not persist. It never
 *   silently reports success.
 */

const EMPTY = emptyPersonalState();

let initialized = false;
let cache: PersonalState = EMPTY;
let writeError: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function readFromStorage(): void {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(PERSONAL_STATE_KEY);
  } catch {
    writeError = "This browser is blocking local storage, so nothing can be saved.";
    cache = EMPTY;
    return;
  }
  const parsed = parsePersonalState(raw);
  // Keep the reference when nothing changed: useSyncExternalStore compares with
  // Object.is and would otherwise re-render on every read.
  cache = JSON.stringify(parsed) === JSON.stringify(cache) ? cache : parsed;
}

export function getPersonalSnapshot(): PersonalState {
  if (!initialized) {
    initialized = true;
    readFromStorage();
  }
  return cache;
}

/** During SSR and hydration there is no storage, and no claim is made about one. */
export function getServerPersonalSnapshot(): PersonalState {
  return EMPTY;
}

export function getPersonalWriteError(): string | null {
  return writeError;
}

export function getServerWriteError(): null {
  return null;
}

export function subscribePersonal(listener: () => void): () => void {
  listeners.add(listener);

  // Another tab changing the same key is a real external update. It must refresh
  // this tab, or a learner would see two different notebooks in two windows.
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== PERSONAL_STATE_KEY) return;
    writeError = null;
    initialized = true;
    readFromStorage();
    notify();
  };
  window.addEventListener("storage", onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Apply a pure update and persist the result.
 *
 * Returns the new write error, or null. The in-memory state is authoritative even
 * when the write fails, so the interface stays usable; the error tells the truth
 * about what will survive a reload.
 */
export function updatePersonal(
  update: (state: PersonalState) => PersonalState,
): string | null {
  const current = getPersonalSnapshot();
  const next = update(current);
  if (next === current) return writeError;

  cache = next;
  try {
    window.localStorage.setItem(PERSONAL_STATE_KEY, JSON.stringify(next));
    writeError = null;
  } catch {
    writeError =
      "This browser refused the save (storage is full or blocked). The change is visible but will not survive a reload.";
  }
  notify();
  return writeError;
}
