/**
 * 7.4.3: the pre-charge verification gate.
 *
 * On 2026-09-02 CPC Marketing's monthly invoice charged $392.70 while their
 * Billing page showed $574.30. Nothing was miscomputed in the narrow sense —
 * the invoice billed the AVERAGE usage over the period (daily snapshots)
 * while the page showed the usage of the moment, and a company that tripled
 * its storage during the month landed far apart on the two definitions. The
 * fix has two halves: chargeInstance now bills the same current-usage number
 * the page shows, and THIS module makes sure that equality can never rot
 * silently again — every invoice draft is compared, line by line and in
 * total, against two independent recomputations before any money moves. A
 * mismatch blocks the charge; it never "probably matches".
 *
 * Pure functions only, no imports — so the money math can be exercised by a
 * plain script without a database or a Stripe key.
 */

/** What the app believes the invoice must contain — the exact numbers the
 *  Billing page displays (computeCurrentBillable). All money in cents. */
export interface ExpectedInvoice {
  billableUsers: number
  billableGiB: number
  userCents: number
  storageCents: number
  totalCents: number
  currency: string
}

/** The slice of a Stripe draft-invoice line the check cares about. */
export interface DraftLine {
  quantity: number | null
  amount: number
  currency: string
  description: string | null
  /** line.pricing.unit_amount_decimal — null when Stripe omits it. */
  unitAmountDecimal: string | null
}

export interface DraftInvoiceCheck {
  /** Usage read BEFORE the invoice items were created. */
  first: ExpectedInvoice
  /** Usage read again AFTER — the "double check". Must be identical. */
  second: ExpectedInvoice
  lines: DraftLine[]
  /** false when Stripe reports has_more on the line list — more lines exist
   *  than we fetched, which alone is proof something foreign got attached. */
  linesComplete: boolean
  invoiceTotalCents: number
  invoiceCurrency: string
  /** stripe customer.balance — a credit (negative) or debit (positive) would
   *  make the amount actually collected differ from the invoice total. */
  customerBalanceCents: number
}

const centsToDollars = (c: number) => `$${(c / 100).toFixed(2)}`

/**
 * Compare a Stripe draft invoice against the app's own numbers. Returns a
 * list of plain-English problems — empty means the draft is EXACTLY the
 * Billing page's breakdown and finalizing it will charge exactly that.
 * Any entry means: delete the draft, charge nothing, log everything.
 */
export function verifyDraftInvoice(check: DraftInvoiceCheck): string[] {
  const problems: string[] = []
  const { first, second } = check

  // 1) The two independent DB reads must agree — if usage moved while the
  //    invoice was being assembled, the draft matches neither moment cleanly.
  //    Rounded whole-GiB quantities make this stable in practice; a mismatch
  //    here is either a giant upload landing mid-charge (retry succeeds) or
  //    a nondeterministic usage query (must be looked at).
  if (
    first.billableUsers !== second.billableUsers ||
    first.billableGiB !== second.billableGiB ||
    first.totalCents !== second.totalCents
  ) {
    problems.push(
      `usage changed while the invoice was being built (users ${first.billableUsers}→${second.billableUsers}, ` +
        `GB ${first.billableGiB}→${second.billableGiB}, total ${centsToDollars(first.totalCents)}→${centsToDollars(second.totalCents)})`,
    )
  }

  // 2) Every line must be visible to the check.
  if (!check.linesComplete) {
    problems.push('Stripe reports more invoice lines than were fetched — a foreign line item is attached')
  }

  // 3) The draft must hold EXACTLY our expected lines — nothing missing
  //    (the historical "$0 invoice" failure, where items didn't attach),
  //    nothing extra (pending items from another product on the same Stripe
  //    account), nothing at a different quantity or amount.
  interface Want {
    label: string
    quantity: number
    amountCents: number
    unitCents: number
  }
  const wants: Want[] = []
  if (first.billableUsers > 0) {
    wants.push({
      label: 'users',
      quantity: first.billableUsers,
      amountCents: first.userCents,
      unitCents: first.billableUsers ? first.userCents / first.billableUsers : 0,
    })
  }
  if (first.billableGiB > 0) {
    wants.push({
      label: 'storage',
      quantity: first.billableGiB,
      amountCents: first.storageCents,
      unitCents: first.billableGiB ? first.storageCents / first.billableGiB : 0,
    })
  }

  const unmatched = [...check.lines]
  for (const want of wants) {
    const idx = unmatched.findIndex(
      (l) => l.quantity === want.quantity && l.amount === want.amountCents,
    )
    if (idx === -1) {
      problems.push(
        `expected a ${want.label} line of ${want.quantity} × ${centsToDollars(want.unitCents)} = ${centsToDollars(want.amountCents)} and the draft has none`,
      )
      continue
    }
    const line = unmatched.splice(idx, 1)[0]
    if (line.currency.toLowerCase() !== first.currency.toLowerCase()) {
      problems.push(`the ${want.label} line is in ${line.currency}, expected ${first.currency}`)
    }
    // When Stripe echoes the unit price, it must be OUR unit price — the
    // quantity+amount pair already pins the product, this pins the factors.
    if (line.unitAmountDecimal != null) {
      const unit = Number(line.unitAmountDecimal)
      if (Number.isFinite(unit) && Math.abs(unit - want.unitCents) > 1e-9) {
        problems.push(
          `the ${want.label} line has unit price ${centsToDollars(unit)}, expected ${centsToDollars(want.unitCents)}`,
        )
      }
    }
  }
  for (const stray of unmatched) {
    problems.push(
      `the draft carries a line that is not ours: "${stray.description ?? '(no description)'}" ` +
        `— ${stray.quantity ?? '?'} × ? = ${centsToDollars(stray.amount)}`,
    )
  }

  // 4) The bottom line: what Stripe will collect must be the page's total.
  if (check.invoiceTotalCents !== first.totalCents) {
    problems.push(
      `draft total is ${centsToDollars(check.invoiceTotalCents)}, the Billing page total is ${centsToDollars(first.totalCents)}`,
    )
  }
  if (check.invoiceCurrency.toLowerCase() !== first.currency.toLowerCase()) {
    problems.push(`draft currency is ${check.invoiceCurrency}, expected ${first.currency}`)
  }

  // 5) A Stripe customer balance (credit note, manual adjustment) silently
  //    changes the amount actually collected at finalization. That would
  //    break "charged = page" in a way the lines can't show — block and let
  //    a human resolve the balance first.
  if (check.customerBalanceCents !== 0) {
    problems.push(
      `the Stripe customer carries a balance of ${centsToDollars(Math.abs(check.customerBalanceCents))} ` +
        `${check.customerBalanceCents < 0 ? 'credit' : 'debit'} — the collected amount would differ from the invoice total`,
    )
  }

  return problems
}
