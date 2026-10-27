import { createContext, useContext } from "react";

import type { Api, DeviceInfo, Me } from "./lib/api.js";
import type { Lang, Translate } from "./lib/i18n.js";

export interface AppContext {
  api: Api;
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translate;
  me: Me;
  /** The PC the chosen company lives on. */
  device: DeviceInfo;
  inn: string;
  /** The selected company's name. */
  companyName: string;
  reloadMe: () => Promise<void>;
  go: (tab: "chat" | "waiting" | "files" | "status") => void;
  /** Cards waiting for the user, as last seen. */
  waitingCount: number;
  setWaitingCount: (n: number) => void;
}

export const Ctx = createContext<AppContext | null>(null);

export function useApp(): AppContext {
  const value = useContext(Ctx);
  if (!value) throw new Error("useApp outside the app");
  return value;
}
