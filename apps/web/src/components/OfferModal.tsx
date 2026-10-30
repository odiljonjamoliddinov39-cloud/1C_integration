import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { type Locale, href } from "../lib/i18n";
import { offerOf } from "../lib/offer";
import { OfferDocument } from "./OfferDocument";

/**
 * The public offer, shown before a purchase: the full text in the site's language and, below it, "Agree". Nothing is bought
 * until it is pressed (the server refuses a purchase without the acceptance too).
 */
export function OfferModal({
  locale,
  busy,
  error,
  onAgree,
  onCancel,
}: {
  locale: Locale;
  busy: boolean;
  error: string | null;
  onAgree: () => void;
  onCancel: () => void;
}) {
  const offer = offerOf(locale);
  const ui = offer.ui;
  const agreeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onCancel();
    window.addEventListener("keydown", onKey);
    agreeRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [busy, onCancel]);

  // In the body, outside the page's own stacking contexts (the cabinet's background isolates its content), so it is above the header.
  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/55 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={() => !busy && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="offer-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl border border-border bg-card shadow-2xl shadow-primary/20 sm:max-h-[88dvh] sm:rounded-3xl"
      >
        <div className="border-b border-border px-5 py-4 sm:px-7">
          <h2 id="offer-title" className="text-xl font-extrabold tracking-tight">
            {ui.modalTitle}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{ui.modalIntro}</p>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 sm:px-7">
          <OfferDocument locale={locale} />
        </div>
        <div className="border-t border-border bg-card px-5 py-4 sm:px-7">
          {error && (
            <p role="alert" className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <a
              href={href(locale, "/oferta")}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-muted-foreground underline hover:text-foreground"
            >
              {ui.openPage}
            </a>
            <div className="ml-auto flex w-full gap-3 sm:w-auto">
              <button
                type="button"
                disabled={busy}
                onClick={onCancel}
                className="btn btn-ghost flex-1 sm:flex-none"
              >
                {ui.cancel}
              </button>
              <button
                ref={agreeRef}
                type="button"
                disabled={busy}
                onClick={onAgree}
                className="btn btn-primary flex-1 disabled:opacity-60 sm:flex-none"
              >
                {busy ? ui.working : ui.agree}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
