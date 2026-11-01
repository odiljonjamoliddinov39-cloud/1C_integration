import { createContext, useContext } from "react";

import type { CrmMe, CrmPipelineView } from "@platform/shared";

import type { Api } from "./lib/api.js";
import type { Lang, Words } from "./lib/i18n.js";

/** What every screen has, signed in or not. */
export interface AuthContext {
  api: Api;
  words: Words;
  lang: Lang;
  setLang: (lang: Lang) => void;
}

export interface AppContext extends AuthContext {
  me: CrmMe;
  funnel: CrmPipelineView;
  reloadFunnel: () => Promise<void>;
  signOut: () => void;
  /** Shows a short message at the bottom of the screen. */
  toast: (text: string) => void;
}

export const Ctx = createContext<AuthContext | null>(null);

export function useAuth(): AuthContext {
  const value = useContext(Ctx);
  if (!value) throw new Error("useAuth outside the app");
  return value;
}

export function useApp(): AppContext {
  return useAuth() as AppContext;
}
