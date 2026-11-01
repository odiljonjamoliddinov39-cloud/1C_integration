/**
 * Routes live in the URL hash (#/crm/leads/<id>), so the server only ever serves /admin/. A route is [area, section, id]: the area
 * (Buxgalteriya, CRM, …) picks the menu, the section the page. A hash with no area (an old link, #/customers/<id>) is the
 * Buxgalteriya's.
 */
import { useSyncExternalStore } from "react";

export const AREA_IDS = ["buxgalteriya", "crm"] as const;
export type AreaId = (typeof AREA_IDS)[number];
export const DEFAULT_AREA: AreaId = "buxgalteriya";

const isArea = (s: string | undefined): s is AreaId => AREA_IDS.includes(s as AreaId);

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** [area, section, id] of the current hash; the section and the id are "" / undefined when absent. */
export function parseRoute(hash: string): [AreaId, string, string | undefined] {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const area = isArea(parts[0]) ? parts.shift() : undefined;
  return [(area ?? DEFAULT_AREA) as AreaId, parts[0] ?? "", parts[1]];
}

export function useRoute(): [AreaId, string, string | undefined] {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}

/** A link to a page: "customers/<id>" is in the Buxgalteriya, "crm/leads" names its area itself. */
export function href(path: string, area?: AreaId): string {
  const clean = path.replace(/^\//, "");
  const first = clean.split("/")[0];
  return isArea(first) ? `#/${clean}` : `#/${area ?? DEFAULT_AREA}${clean ? `/${clean}` : ""}`;
}
