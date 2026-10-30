import { type Locale } from "../lib/i18n";
import { offerOf } from "../lib/offer";

/** The text of the public offer, in the language of the site. Used on the offer page and in the purchase window. */
export function OfferDocument({ locale }: { locale: Locale }) {
  const offer = offerOf(locale);
  return (
    <article className="text-sm leading-relaxed">
      <p className="text-muted-foreground">{offer.subtitle}</p>
      <p className="mt-1 text-xs text-muted-foreground">{offer.dated}</p>
      {offer.sections.map((section) => (
        <section key={section.title} className="mt-6">
          <h2 className="text-base font-bold">{section.title}</h2>
          <div className="mt-2 space-y-2">
            {section.items.map((item) => (
              <div key={item.text}>
                <p>{item.text}</p>
                {item.list && (
                  <ul className="mt-1 list-disc space-y-1 pl-6 text-muted-foreground">
                    {item.list.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
      <dl className="mt-3 overflow-hidden rounded-xl border border-border">
        {offer.requisites.map(([label, value]) => (
          <div
            key={label}
            className="grid grid-cols-[minmax(7rem,40%)_1fr] gap-3 border-b border-border px-4 py-2 last:border-b-0 odd:bg-muted/40"
          >
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}
