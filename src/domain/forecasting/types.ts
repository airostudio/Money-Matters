/**
 * Cash forecast types (master spec §38).
 *
 * **The KNOWN/STATISTICAL separation is structural, not a label.** A
 * forecast line is one of two different TYPES (`KnownForecastLine` /
 * `StatisticalForecastLine`), discriminated by `kind`, and carries different
 * fields: a known line points at the source document whose own stated terms
 * justify it (`statedDate`, `timing`), a statistical line carries the
 * `basis` — the explicit, explainable average it was derived from — and may
 * name the known line it supersedes in the "including statistical
 * projections" series (`replacesLineId`). The forecast result exposes TWO
 * separate series built from them (`knownOnly`, `withStatistical`); there is
 * deliberately no field anywhere that sums both kinds into one number.
 */

export const FORECAST_HORIZONS = ["7D", "30D", "60D", "90D", "12M"] as const;
export type ForecastHorizon = (typeof FORECAST_HORIZONS)[number];

/** Horizon length in days. 12 months is 365 days, not calendar-month arithmetic, so every horizon is "N days from today". */
export const HORIZON_DAYS: Record<ForecastHorizon, number> = {
  "7D": 7,
  "30D": 30,
  "60D": 60,
  "90D": 90,
  "12M": 365,
};

export type ForecastDirection = "IN" | "OUT";

export type ForecastCategory =
  | "CUSTOMER_INVOICE"
  | "SUPPLIER_BILL"
  | "PAYMENT_RUN"
  | "RECURRING_INVOICE"
  | "RECURRING_BILL"
  | "PAYROLL_LIABILITY"
  | "PAYROLL_PROJECTION";

export type ForecastSourceType =
  | "INVOICE"
  | "BILL"
  | "PAYMENT_RUN"
  | "RECURRING_INVOICE_TEMPLATE"
  | "RECURRING_BILL_TEMPLATE"
  | "PAY_RUN"
  | "GL_ACCOUNT";

export interface ForecastSourceRef {
  type: ForecastSourceType;
  id: string;
  /** Human label, e.g. the invoice number. */
  label: string;
  /** Org-relative path (no leading org slug) the UI prefixes with `/${orgSlug}`; null where no detail page exists. */
  href: string | null;
}

/**
 * Why a KNOWN line sits on the date it does:
 *  - `STATED_DUE_DATE`: the open document's own due date, still in the future (or today).
 *  - `OVERDUE_ASSUMED_DUE_NOW`: a bill we owe whose due date has already passed — assumed payable immediately (the prudent direction for an outflow).
 *  - `OVERDUE_RECEIPT_UNDATED`: an invoice owed TO us whose due date has already passed. The amount is certain; the receipt date is not determinable from any document, so it is NOT placed on the known-only timeline (`date` is null) — the prudent direction for an inflow.
 *  - `SCHEDULED_PAYMENT_RUN`: a bill inside an APPROVED payment run, dated at the run's own payment date.
 *  - `TEMPLATE_SCHEDULE`: an active recurring template's explicit schedule (+ the platform's fixed default payment terms).
 *  - `UNVERIFIED`: a known amount whose due-date rule has not been verified (payroll remittances) — never placed on the timeline.
 */
export type KnownTiming =
  | "STATED_DUE_DATE"
  | "OVERDUE_ASSUMED_DUE_NOW"
  | "OVERDUE_RECEIPT_UNDATED"
  | "SCHEDULED_PAYMENT_RUN"
  | "TEMPLATE_SCHEDULE"
  | "UNVERIFIED";

interface ForecastLineBase {
  /** Stable across runs for the same underlying fact — a statistical line's `replacesLineId` points at one of these. */
  id: string;
  direction: ForecastDirection;
  category: ForecastCategory;
  label: string;
  counterparty?: string;
  /** Always a positive decimal string, base currency; `direction` carries the sign. */
  amount: string;
  /** The date this line is projected on (YYYY-MM-DD, already clamped to today if the stated date has passed); null when it has no determinable date and so is not on the timeline. */
  date: string | null;
  source: ForecastSourceRef;
  note?: string;
}

/** A commitment grounded in a real document or schedule — see `KnownTiming` for exactly what justifies its date. */
export interface KnownForecastLine extends ForecastLineBase {
  kind: "KNOWN";
  timing: KnownTiming;
  /** The source document's own date (due date, template run date, payment run date) before any clamping to today. */
  statedDate: string | null;
}

/** What a statistical line was derived from — always a simple, explainable average, never a model. */
export type StatisticalBasis =
  | {
      type: "CUSTOMER_AVG_DAYS_LATE";
      /** This customer's average settlement date minus due date across their already-PAID invoices (negative = pays early). */
      avgDaysLate: number;
      /** How many settled invoices that average was computed from — a small number means a weak estimate, and the UI says so. */
      settledInvoiceCount: number | null;
    }
  | {
      type: "REPEAT_OF_LAST_POSTED_PAY_RUN";
      /** Pay frequency the last posted run repeats at. */
      payFrequency: string;
      lastPayDate: string;
    };

/** A projection derived from history. Never mixed into the known-only series. */
export interface StatisticalForecastLine extends ForecastLineBase {
  kind: "STATISTICAL";
  basis: StatisticalBasis;
  /**
   * When set, this line SUPERSEDES the named KNOWN line in the "including
   * statistical projections" series (same cash, different expected date) —
   * it is the structural form of "due Friday, but this customer typically
   * pays 12 days late". Absent for a purely additive projection.
   */
  replacesLineId?: string;
  date: string;
}

export type ForecastLine = KnownForecastLine | StatisticalForecastLine;

export interface ForecastSeriesPoint {
  /** YYYY-MM-DD. End-of-day projected balance; the first point (today) already includes any flow dated today. */
  date: string;
  balance: string;
}

export interface ForecastSeries {
  /** Daily for horizons up to 90 days, weekly (end-of-week) for 12 months — see `CashForecast.granularity`. */
  points: ForecastSeriesPoint[];
  endBalance: string;
  /** Lowest end-of-day balance over the horizon, from the DAILY series even when `points` is weekly. */
  lowPoint: { date: string; balance: string };
  totalIn: string;
  totalOut: string;
}

export interface LowCashBreach {
  /** First calendar day the end-of-day balance is below the threshold. */
  date: string;
  daysFromNow: number;
  /** Balance on that day. */
  balance: string;
}

export interface LowCashWarning {
  threshold: string;
  /** Null when this series never breaches the threshold within the horizon. */
  knownOnly: LowCashBreach | null;
  withStatistical: LowCashBreach | null;
  /** Earliest of the two breaches — what a headline should lead with. */
  firstBreach: (LowCashBreach & { series: "KNOWN_ONLY" | "INCLUDING_STATISTICAL" }) | null;
  /** Plain-language message in the master spec §6 "Cash Warning" style, always naming which series it is about. */
  message: string | null;
}

export interface UnscheduledKnownSummary {
  /** Known amounts with no determinable date, kept OFF both timelines. */
  inflows: string;
  outflows: string;
  lineIds: string[];
  /**
   * Lowest known-only balance if every unscheduled OUTFLOW were paid on day
   * zero — a prudence floor for liabilities (payroll remittances) whose due
   * date this slice cannot verify. A bound, not a prediction.
   */
  lowPointIfUnscheduledOutflowsPaidNow: string;
}

export interface CashForecast {
  asOf: string;
  currency: string;
  horizon: ForecastHorizon;
  horizonDays: number;
  granularity: "DAILY" | "WEEKLY";
  openingCash: {
    total: string;
    accounts: Array<{ bankAccountId: string; name: string; institutionName: string | null; balance: string }>;
  };
  lowCashThreshold: string;
  /** Series 1: only commitments grounded in documents/schedules. */
  knownOnly: ForecastSeries;
  /** Series 2: the known commitments with statistical timing shifts and projections layered on. */
  withStatistical: ForecastSeries;
  warning: LowCashWarning;
  unscheduledKnown: UnscheduledKnownSummary;
  /** Every line within the horizon (plus every undated known line), KNOWN and STATISTICAL kept distinct by `kind`. */
  lines: ForecastLine[];
  /** True when the actor lacks `payrun:read`, so payroll-derived lines were omitted rather than shown or errored. */
  payrollOmitted: boolean;
  /** Plain-language limitations to show beside the numbers. */
  caveats: string[];
}
