/**
 * Accounting arithmetic done by the program, not by the model: VAT, depreciation, loans, discounting, foreign
 * currency revaluation, stock costing, payroll, customs landed cost, penalties, ratios, break-even and exact
 * allocation. The model chooses the operation and the inputs; every figure in the answer is computed here, so a sum
 * is never "about right". Money is rounded to two decimals at the end of each step, as a ledger does, and parts that
 * must add up to a whole (an allocation, a schedule) are made to.
 */
import type { AccountingCalcInput } from "@platform/shared";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;

export type CalcResult = Record<string, unknown>;

/** Shares of a whole proportional to the weights, in cents, the last part taking the remainder so that they add up. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return weights.map(() => 0);
  const cents = Math.round(total * 100);
  const parts = weights.map((w) => Math.floor((cents * w) / sum));
  let left = cents - parts.reduce((a, b) => a + b, 0);
  // The remainder goes one cent at a time to the largest fractional parts, so no part is off by more than a cent.
  const order = weights
    .map((w, i) => ({ i, frac: (cents * w) / sum - Math.floor((cents * w) / sum) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; left > 0 && k < order.length; k++, left--) {
    const at = order[k]?.i ?? 0;
    parts[at] = (parts[at] ?? 0) + 1;
  }
  return parts.map((p) => p / 100);
}

function vat(input: Extract<AccountingCalcInput, { op: "vat" }>): CalcResult {
  const rate = input.rate / 100;
  if (input.mode === "inclusive") {
    const net = round2(input.amount / (1 + rate));
    return { net, vat: round2(input.amount - net), gross: input.amount, rate: input.rate, mode: input.mode };
  }
  const vatAmount = round2(input.amount * rate);
  return {
    net: input.amount,
    vat: vatAmount,
    gross: round2(input.amount + vatAmount),
    rate: input.rate,
    mode: input.mode,
  };
}

function depreciation(input: Extract<AccountingCalcInput, { op: "depreciation" }>): CalcResult {
  const { cost, residual = 0, method } = input;
  const periods = input.periods;
  const base = cost - residual;
  const schedule: { period: number; charge: number; accumulated: number; carrying: number }[] = [];
  let accumulated = 0;
  const push = (charge: number) => {
    const capped = Math.min(round2(charge), round2(cost - residual - accumulated));
    accumulated = round2(accumulated + capped);
    schedule.push({
      period: schedule.length + 1,
      charge: capped,
      accumulated,
      carrying: round2(cost - accumulated),
    });
  };
  if (method === "straight_line") {
    const parts = allocate(
      base,
      Array.from({ length: periods }, () => 1),
    );
    for (const part of parts) push(part);
  } else if (method === "declining_balance") {
    const factor = input.factor ?? 2;
    const rate = factor / periods;
    let carrying = cost;
    for (let k = 0; k < periods; k++) {
      const charge = k === periods - 1 ? carrying - residual : Math.min(carrying * rate, carrying - residual);
      push(Math.max(charge, 0));
      carrying = cost - accumulated;
    }
  } else if (method === "sum_of_years") {
    const digits = (periods * (periods + 1)) / 2;
    const weights = Array.from({ length: periods }, (_, k) => (periods - k) / digits);
    const parts = allocate(base, weights);
    for (const part of parts) push(part);
  } else {
    const units = input.units ?? [];
    const parts = allocate(base, units);
    for (const part of parts) push(part);
  }
  return { method, base: round2(base), schedule, total: accumulated };
}

function loan(input: Extract<AccountingCalcInput, { op: "loan" }>): CalcResult {
  const { principal, months } = input;
  const monthly = input.annualRate / 100 / 12;
  const schedule: { month: number; payment: number; interest: number; principal: number; balance: number }[] =
    [];
  let balance = principal;
  const annuity =
    monthly === 0 ? principal / months : (principal * monthly) / (1 - Math.pow(1 + monthly, -months));
  for (let m = 1; m <= months; m++) {
    const interest = round2(balance * monthly);
    let part = input.type === "annuity" ? round2(annuity) - interest : round2(principal / months);
    // The last instalment clears the balance exactly.
    if (m === months) part = round2(balance);
    balance = round2(balance - part);
    schedule.push({ month: m, payment: round2(part + interest), interest, principal: round2(part), balance });
  }
  const totalInterest = round2(schedule.reduce((n, r) => n + r.interest, 0));
  return {
    type: input.type,
    monthlyRate: round4(monthly * 100),
    firstPayment: schedule[0]?.payment ?? 0,
    totalInterest,
    totalPaid: round2(principal + totalInterest),
    schedule,
  };
}

function npvAt(rate: number, flows: number[]): number {
  return flows.reduce((n, cf, t) => n + cf / Math.pow(1 + rate, t), 0);
}

function npvIrr(input: Extract<AccountingCalcInput, { op: "npv_irr" }>): CalcResult {
  const flows = input.cashflows;
  const npv = round2(npvAt(input.rate / 100, flows));
  // IRR by bisection between -99% and 1000%: the rate where the NPV changes sign.
  let lo = -0.99;
  let hi = 10;
  let irr: number | null = null;
  if (npvAt(lo, flows) * npvAt(hi, flows) < 0) {
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (npvAt(lo, flows) * npvAt(mid, flows) <= 0) hi = mid;
      else lo = mid;
    }
    irr = (lo + hi) / 2;
  }
  let cumulative = 0;
  let payback: number | null = null;
  for (let t = 0; t < flows.length; t++) {
    const before = cumulative;
    cumulative += flows[t] ?? 0;
    if (payback === null && cumulative >= 0 && t > 0) {
      const flow = flows[t] ?? 0;
      payback = round2(t - 1 + (flow === 0 ? 1 : -before / flow));
    }
  }
  return { npv, irrPercent: irr === null ? null : round4(irr * 100), paybackPeriods: payback };
}

function fxRevaluation(input: Extract<AccountingCalcInput, { op: "fx_revaluation" }>): CalcResult {
  let total = 0;
  const lines = input.items.map((item) => {
    const book = round2(item.amount * item.bookRate);
    const closing = round2(item.amount * item.closingRate);
    // An asset worth more is a gain; a liability that costs more is a loss.
    const raw = round2(closing - book);
    const difference = item.kind === "liability" ? -raw : raw;
    total = round2(total + difference);
    return {
      name: item.name,
      kind: item.kind,
      amount: item.amount,
      bookValue: book,
      closingValue: closing,
      difference,
      result: difference > 0 ? "exchange gain" : difference < 0 ? "exchange loss" : "none",
    };
  });
  return { lines, total, result: total > 0 ? "exchange gain" : total < 0 ? "exchange loss" : "none" };
}

function costing(input: Extract<AccountingCalcInput, { op: "costing" }>): CalcResult {
  type Lot = { qty: number; unit: number };
  const lots: Lot[] =
    input.opening && input.opening.qty > 0 ? [{ qty: input.opening.qty, unit: input.opening.unitCost }] : [];
  const issues: { qty: number; cost: number; unit: number; note?: string }[] = [];
  const average = () => {
    const qty = lots.reduce((n, l) => n + l.qty, 0);
    const value = lots.reduce((n, l) => n + l.qty * l.unit, 0);
    return qty > 0 ? value / qty : 0;
  };
  for (const move of input.movements) {
    if (move.type === "in") {
      lots.push({ qty: move.qty, unit: move.unitCost ?? 0 });
      continue;
    }
    let need = move.qty;
    let cost = 0;
    if (input.method === "average") {
      // Every unit costs the average of what is in stock; the lots shrink in proportion, keeping that average.
      const available = lots.reduce((n, l) => n + l.qty, 0);
      const take = Math.min(need, available);
      cost = take * average();
      for (const lot of lots) lot.qty -= available > 0 ? (lot.qty / available) * take : 0;
      need -= take;
    } else {
      const order = input.method === "lifo" ? [...lots].reverse() : lots;
      for (const lot of order) {
        if (need <= 0) break;
        const take = Math.min(lot.qty, need);
        cost += take * lot.unit;
        lot.qty -= take;
        need -= take;
      }
    }
    const taken = move.qty - Math.max(need, 0);
    issues.push({
      qty: move.qty,
      cost: round2(cost),
      unit: taken > 0 ? round4(cost / taken) : 0,
      ...(need > 1e-9 ? { note: `${round4(need)} short: not enough in stock` } : {}),
    });
  }
  const left = lots.filter((l) => l.qty > 1e-9);
  const closingQty = round4(left.reduce((n, l) => n + l.qty, 0));
  const closingValue = round2(left.reduce((n, l) => n + l.qty * l.unit, 0));
  return {
    method: input.method,
    issues,
    costOfGoodsSold: round2(issues.reduce((n, i) => n + i.cost, 0)),
    closing: {
      qty: closingQty,
      value: closingValue,
      unitCost: closingQty > 0 ? round4(closingValue / closingQty) : 0,
    },
  };
}

/** Uzbekistan's payroll rates as the program knows them: they change, so they are inputs and reported back. */
const PAYROLL_DEFAULTS = { incomeTax: 12, inpsEmployee: 0.1, employerSocial: 12 };

function payroll(input: Extract<AccountingCalcInput, { op: "payroll" }>): CalcResult {
  const rates = {
    incomeTax: input.incomeTaxRate ?? PAYROLL_DEFAULTS.incomeTax,
    inpsEmployee: input.inpsRate ?? PAYROLL_DEFAULTS.inpsEmployee,
    employerSocial: input.employerSocialRate ?? PAYROLL_DEFAULTS.employerSocial,
  };
  // The income tax is on the gross unless `taxAfterInps` is set (then on the gross less the employee's INPS):
  // the two regimes differ, and the accountant knows which applies.
  const fromGross = (gross: number) => {
    const inps = round2((gross * rates.inpsEmployee) / 100);
    const taxable = input.taxAfterInps ? gross - inps : gross;
    const incomeTax = round2((taxable * rates.incomeTax) / 100);
    return {
      gross: round2(gross),
      incomeTax,
      inpsEmployee: inps,
      net: round2(gross - incomeTax - inps),
      employerSocial: round2((gross * rates.employerSocial) / 100),
    };
  };
  let gross = input.gross ?? 0;
  if (input.net !== undefined) {
    // Gross from net: the deductions are linear in the gross, so it is solved directly.
    const k = input.taxAfterInps
      ? 1 - rates.inpsEmployee / 100 - (rates.incomeTax / 100) * (1 - rates.inpsEmployee / 100)
      : 1 - rates.inpsEmployee / 100 - rates.incomeTax / 100;
    gross = round2(input.net / k);
    // A cent of rounding is corrected by looking at the neighbours.
    for (const candidate of [gross - 0.01, gross, gross + 0.01]) {
      if (Math.abs(fromGross(candidate).net - input.net) < Math.abs(fromGross(gross).net - input.net))
        gross = round2(candidate);
    }
  }
  const result = fromGross(gross);
  return {
    ...result,
    employerCost: round2(result.gross + result.employerSocial),
    ratesUsed: rates,
    ratesNote:
      "Rates are in percent. Defaults are Uzbekistan's as the program knows them (income tax 12, employee INPS 0.1, employer social 12): pass the current rates if the law changed.",
  };
}

function landedCost(input: Extract<AccountingCalcInput, { op: "landed_cost" }>): CalcResult {
  const items = input.items;
  const weights = items.map((i) => (input.allocateBy === "weight" ? (i.weight ?? 0) : i.value));
  const freight = allocate(input.freight ?? 0, weights);
  const insurance = allocate(input.insurance ?? 0, weights);
  const customsFee = allocate(
    input.customsFee ?? 0,
    items.map((i) => i.value),
  );
  const other = allocate(
    input.otherCosts ?? 0,
    items.map((i) => i.value),
  );
  const vatRate = (input.vatRate ?? 0) / 100;
  let totalDuty = 0;
  let totalVat = 0;
  let totalCost = 0;
  const lines = items.map((item, k) => {
    const foreign = item.value + (freight[k] ?? 0) + (insurance[k] ?? 0);
    const customsValue = round2(foreign * input.rate);
    const duty = round2((customsValue * (item.dutyRate ?? 0)) / 100);
    const excise = round2((customsValue * (item.exciseRate ?? 0)) / 100);
    const vatBase = round2(customsValue + duty + excise);
    const vatAmount = round2(vatBase * vatRate);
    // Import VAT is offset against output VAT; it is not part of the cost unless the goods are exempt.
    const cost = round2(
      customsValue +
        duty +
        excise +
        (customsFee[k] ?? 0) +
        (other[k] ?? 0) +
        (input.vatRecoverable === false ? vatAmount : 0),
    );
    totalDuty = round2(totalDuty + duty);
    totalVat = round2(totalVat + vatAmount);
    totalCost = round2(totalCost + cost);
    return {
      name: item.name,
      invoiceValue: item.value,
      customsValueForeign: round2(foreign),
      customsValue,
      duty,
      excise,
      vatBase,
      vat: vatAmount,
      customsFee: customsFee[k] ?? 0,
      otherCosts: other[k] ?? 0,
      cost,
      unitCost: item.qty && item.qty > 0 ? round2(cost / item.qty) : null,
    };
  });
  return {
    allocatedBy: input.allocateBy ?? "value",
    lines,
    totals: { duty: totalDuty, vat: totalVat, cost: totalCost },
    note:
      input.vatRecoverable === false
        ? "Import VAT is included in the cost (not recoverable)."
        : "Import VAT is shown apart: it is offset against output VAT and is not in the cost.",
  };
}

function penalty(input: Extract<AccountingCalcInput, { op: "penalty" }>): CalcResult {
  const days =
    input.days ??
    Math.max(
      0,
      Math.round((Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / 86_400_000),
    );
  const rate = input.ratePerDay ?? 0.033;
  const raw = round2((input.principal * rate * days) / 100);
  const cap = input.capPercent === undefined ? null : round2((input.principal * input.capPercent) / 100);
  const amount = cap === null ? raw : Math.min(raw, cap);
  return {
    days,
    ratePerDayPercent: rate,
    uncapped: raw,
    cap,
    penalty: amount,
    capped: cap !== null && raw > cap,
  };
}

function ratios(input: Extract<AccountingCalcInput, { op: "ratios" }>): CalcResult {
  const out: Record<string, number | null> = {};
  const div = (a: number | undefined, b: number | undefined, scale = 1) =>
    a === undefined || b === undefined || b === 0 ? null : round2((a / b) * scale);
  const days = input.days ?? 365;
  out.currentRatio = div(input.currentAssets, input.currentLiabilities);
  out.quickRatio =
    input.currentAssets === undefined || input.inventory === undefined
      ? null
      : div(input.currentAssets - input.inventory, input.currentLiabilities);
  out.cashRatio = div(input.cash, input.currentLiabilities);
  out.receivableDays = div(input.receivables, input.revenue, days);
  out.payableDays = div(input.payables, input.cogs, days);
  out.inventoryDays = div(input.inventory, input.cogs, days);
  out.grossMarginPercent =
    input.revenue === undefined || input.cogs === undefined
      ? null
      : div(input.revenue - input.cogs, input.revenue, 100);
  out.netMarginPercent = div(input.netIncome, input.revenue, 100);
  out.returnOnEquityPercent = div(input.netIncome, input.equity, 100);
  out.returnOnAssetsPercent = div(input.netIncome, input.totalAssets, 100);
  out.interestCover = div(input.ebit, input.interest);
  out.debtToEquity = div(input.totalDebt, input.equity);
  const given = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null));
  return { ratios: given, daysInPeriod: days };
}

function breakEven(input: Extract<AccountingCalcInput, { op: "break_even" }>): CalcResult {
  const margin = input.price - input.variableCost;
  if (!(margin > 0))
    return { error: "The price does not cover the variable cost: there is no break-even point." };
  const units = input.fixedCosts / margin;
  const out: Record<string, unknown> = {
    contributionPerUnit: round2(margin),
    contributionMarginPercent: round2((margin / input.price) * 100),
    breakEvenUnits: Math.ceil(units),
    breakEvenRevenue: round2(Math.ceil(units) * input.price),
  };
  if (input.targetProfit !== undefined) {
    const target = (input.fixedCosts + input.targetProfit) / margin;
    out.unitsForTargetProfit = Math.ceil(target);
    out.revenueForTargetProfit = round2(Math.ceil(target) * input.price);
  }
  return out;
}

export function accountingCalc(input: AccountingCalcInput): CalcResult {
  switch (input.op) {
    case "vat":
      return vat(input);
    case "depreciation":
      return depreciation(input);
    case "loan":
      return loan(input);
    case "npv_irr":
      return npvIrr(input);
    case "fx_revaluation":
      return fxRevaluation(input);
    case "costing":
      return costing(input);
    case "payroll":
      return payroll(input);
    case "landed_cost":
      return landedCost(input);
    case "penalty":
      return penalty(input);
    case "ratios":
      return ratios(input);
    case "break_even":
      return breakEven(input);
    case "allocate": {
      const parts = allocate(input.total, input.weights);
      return { parts, total: round2(parts.reduce((a, b) => a + b, 0)) };
    }
  }
}
