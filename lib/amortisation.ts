// ── Amortisation Calculations ──
// Real interest cost and payoff math for debt moves.
// Replaces the heuristic estimates (debtPayments × 0.40) with actual amortisation.

/** Monthly interest on a given balance at a given APR */
export function calcMonthlyInterest(balance: number, apr: number): number {
  if (balance <= 0 || apr <= 0) return 0;
  return balance * (apr / 12);
}

/** Number of months to pay off a debt given balance, APR, and fixed monthly payment.
 *  Returns Infinity if payment doesn't cover interest. Capped at 600 months (50 years). */
export function calcPayoffMonths(balance: number, apr: number, monthlyPayment: number): number {
  if (balance <= 0) return 0;
  if (monthlyPayment <= 0) return Infinity;
  if (apr <= 0) return Math.ceil(balance / monthlyPayment);

  const monthlyRate = apr / 12;
  const minInterest = balance * monthlyRate;
  if (monthlyPayment <= minInterest) return Infinity; // never pays off

  // Amortisation formula: n = -ln(1 - r*P/M) / ln(1+r)
  const n = -Math.log(1 - (monthlyRate * balance) / monthlyPayment) / Math.log(1 + monthlyRate);
  return Math.min(600, Math.ceil(n));
}

/** Total interest paid over the life of the debt */
export function calcTotalInterest(balance: number, apr: number, monthlyPayment: number): number {
  if (balance <= 0 || monthlyPayment <= 0) return 0;
  if (apr <= 0) return 0; // no interest on 0% debt

  let remaining = balance;
  const monthlyRate = apr / 12;
  let totalInterest = 0;

  for (let m = 0; m < 600; m++) {
    if (remaining <= 0) break;
    const interest = remaining * monthlyRate;
    totalInterest += interest;
    const principal = Math.min(monthlyPayment - interest, remaining);
    if (principal <= 0) return Infinity; // payment doesn't cover interest
    remaining -= principal;
  }

  return Math.round(totalInterest);
}

/** Interest saved by increasing payment from currentPayment to newPayment */
export function calcInterestSaved(
  balance: number,
  apr: number,
  currentPayment: number,
  newPayment: number,
): number {
  if (balance <= 0 || apr <= 0) return 0;
  const currentTotal = calcTotalInterest(balance, apr, currentPayment);
  const newTotal = calcTotalInterest(balance, apr, newPayment);
  if (currentTotal === Infinity) return 0; // can't compute savings from infinite interest
  return Math.max(0, currentTotal - newTotal);
}
