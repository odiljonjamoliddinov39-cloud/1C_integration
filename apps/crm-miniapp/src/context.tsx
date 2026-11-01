import { createContext, useContext } from "react";

import type { CrmMe, CrmPipelineView } from "@platform/shared";

import type { Api } from "./lib/api.js";
import type { Lang, Words } from "./lib/i18n.js";

export interface AppContext {
  api: Api;
  words: Words;
  lang: Lang;
  setLang: (lang: Lang) => void;
  me: CrmMe;
  funnel: CrmPipelineView;
  reloadFunnel: () => Promise<void>;
  /** Shows a short message at the bottom of the screen. */
  toast: (text: string) => void;
}

export const Ctx = createContext<AppContext | null>(null);

export function useApp(): AppContext {
  const value = useContext(Ctx);
  if (!value) throw new Error("useApp outside the app");
  return value;
}
