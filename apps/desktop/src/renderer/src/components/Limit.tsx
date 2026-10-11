import { type ReactNode, createContext, useCallback, useContext, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useBilling } from "@/lib/billing";

interface Shown {
  code: string;
  message: string;
}

const LimitContext = createContext<(code: string, message: string) => void>(() => undefined);

/** Opens the plain "you reached a limit" message, with the way to upgrade. */
export const useLimitDialog = () => useContext(LimitContext);

export function LimitProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const show = useCallback((code: string, message: string) => setShown({ code, message }), []);
  return (
    <LimitContext.Provider value={show}>
      {children}
      {shown && <LimitDialog shown={shown} onClose={() => setShown(null)} />}
    </LimitContext.Provider>
  );
}

function LimitDialog({ shown, onClose }: { shown: Shown; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const billing = useBilling();
  const key = `billing.limit.${shown.code}`;
  const known = i18n.exists(`${key}.title`);
  const cabinet = billing?.cabinetUrl ?? null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={onClose}
    >
      <Card className="w-full max-w-md p-6" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">{known ? t(`${key}.title`) : shown.code}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{known ? t(`${key}.body`) : shown.message}</p>
        {!cabinet && <p className="mt-2 text-xs text-muted-foreground">{t("billing.cabinet")}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t("billing.close")}
          </Button>
          {cabinet && (
            <Button
              onClick={() => {
                window.open(cabinet, "_blank");
                onClose();
              }}
            >
              {t("billing.upgrade")}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
