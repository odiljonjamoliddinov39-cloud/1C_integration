/**
 * Phone numbers. The digits are the identity of a lead (`phone_key`): "+998 90 123-45-67", "90 123 45 67" and "998901234567" are
 * one lead. A number with 9 digits is taken as Uzbek (the code 998 is added); anything else has to be an international number of
 * 11 to 15 digits. Letters in the number make it broken, not "cleaned".
 */
export interface Phone {
  /** How the number is shown: +998901234567 */
  display: string;
  /** What two writings of one number share: 998901234567 */
  key: string;
}

export function normalizePhone(raw: string): Phone | null {
  // A spreadsheet's text marker (a leading '), non-breaking spaces and quotes are not part of the number.
  const text = raw.replace(/[\u00a0\u202f'"`’‘]/g, " ").trim();
  if (!text || /[^\d\s()+\-.]/.test(text)) return null;
  let digits = text.replace(/\D/g, "");
  if (digits.length === 9) digits = `998${digits}`;
  if (digits.length === 10 && digits.startsWith("0")) digits = `998${digits.slice(1)}`;
  if (digits.length < 11 || digits.length > 15) return null;
  return { display: `+${digits}`, key: digits };
}

/**
 * The number in a cell that may hold several ("90 123 45 67, 91 222 33 44", "90 123 45 67 / 71 200 10 10"): the first one that is
 * valid. Null when none is.
 */
export function firstPhone(raw: string): Phone | null {
  const whole = normalizePhone(raw);
  if (whole) return whole;
  for (const part of raw.split(/[,;/\n]+/)) {
    const phone = normalizePhone(part);
    if (phone) return phone;
  }
  return null;
}
