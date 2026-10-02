// Session (current user) and company selection (one company or the combined view).

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { api, getToken, setToken, setUnauthorizedHandler } from "./api";
import type { Company, User } from "./types";

interface Session {
  user: User | null;
  loading: boolean;
  login: (token: string, user: User) => void;
  logout: () => void;
  canWrite: boolean;
  isOwner: boolean;
  companies: Company[];
  reloadCompanies: () => Promise<void>;
  companyId: number | null; // null = all companies
  setCompanyId: (id: number | null) => void;
  company: Company | null;
}

const SessionContext = createContext<Session | null>(null);
const COMPANY_KEY = "onec.company";

function readCompany(): number | null {
  try {
    const v = localStorage.getItem(COMPANY_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyIdState] = useState<number | null>(readCompany);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setCompanies([]);
  }, []);

  const reloadCompanies = useCallback(async () => {
    const list = await api<Company[]>("/api/companies");
    setCompanies(list);
    setCompanyIdState((current) => (current !== null && !list.some((c) => c.id === current) ? null : current));
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api<User>("/api/auth/me")
      .then(async (me) => {
        setUser(me);
        await reloadCompanies();
      })
      .catch(() => logout())
      .finally(() => setLoading(false));
  }, [logout, reloadCompanies]);

  const login = useCallback(
    (token: string, me: User) => {
      setToken(token);
      setUser(me);
      void reloadCompanies();
    },
    [reloadCompanies],
  );

  const setCompanyId = useCallback((id: number | null) => {
    setCompanyIdState(id);
    try {
      if (id === null) localStorage.removeItem(COMPANY_KEY);
      else localStorage.setItem(COMPANY_KEY, String(id));
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<Session>(
    () => ({
      user,
      loading,
      login,
      logout,
      canWrite: user?.role === "owner" || user?.role === "accountant",
      isOwner: user?.role === "owner",
      companies,
      reloadCompanies,
      companyId,
      setCompanyId,
      company: companies.find((c) => c.id === companyId) ?? null,
    }),
    [user, loading, login, logout, companies, reloadCompanies, companyId, setCompanyId],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}

/** Small data-loading hook: re-runs when `deps` change; `reload()` refetches. */
export function useData<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((d) => !cancelled && setData(d))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1), setData };
}
