/** Routes live in the URL hash (#/customers/<id>), so the server only ever serves /admin/. */
import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}

export function href(path: string): string {
  return `#/${path.replace(/^\//, "")}`;
}
