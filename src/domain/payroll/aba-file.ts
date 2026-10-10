import Decimal from "decimal.js";

/**
 * ABA / Australian Direct Entry file generation - Phase 8 Slice 3.
 *
 * Money Matters only GENERATES a file for a person to upload to their own bank. It never transmits anything, holds no
 * bank credentials, and the originating bank/APCA identifiers are supplied by a human at generation time (never stored
 * or invented).
 *
 * The record layouts below were verified against two independent sources (see docs/roadmap.md, Phase 8):
 *   1. Westpac Corporate Online, "Import format for Australian Direct Entry files" (effective January 2018), PDF.
 *   2. Cemtex ABA "file format technical details" (cemtexaba.com), which matches field for field; BOQ and NAB
 *      Direct Entry specifications were seen to use the same three-record structure.
 * All three record types are 120 characters, terminated by a CR/LF pair (Westpac lists CR, LF and CR+LF as acceptable).
 *
 *   Type 0 (descriptive): 1 '0' | 2-18 blank | 19-20 reel sequence (01) | 21-23 FI abbreviation | 24-30 blank |
 *     31-56 user name (26, left) | 57-62 APCA user id (6, numeric, zero-filled) | 63-74 description (12, left) |
 *     75-80 processing date DDMMYY | 81-120 blank
 *   Type 1 (detail): 1 '1' | 2-8 BSB nnn-nnn | 9-17 account number (9, right-justified) | 18 indicator (blank) |
 *     19-20 transaction code ('53' = pay) | 21-30 amount in cents (10, zero-filled) | 31-62 account title (32, left) |
 *     63-80 lodgement reference (18, left) | 81-87 trace BSB | 88-96 trace account (9, right) | 97-112 remitter (16, left) |
 *     113-120 withholding tax (8, zero-filled)
 *   Type 7 (file total): 1 '7' | 2-8 '999-999' | 9-20 blank | 21-30 net total | 31-40 credit total | 41-50 debit total |
 *     51-74 blank | 75-80 count of type 1 records | 81-120 blank
 *
 * NOT done, and why: no balancing debit record is added (credits only; whether the originating bank wants a
 * self-balancing debit record is bank-specific and was not verified). No withholding-tax indicators (not payroll).
 * Amounts are whole cents (the ledger carries four decimal places, so the per-employee rounding is reported).
 */

export const ABA_RECORD_LENGTH = 120;
export const ABA_PAY_TRANSACTION_CODE = "53";

const VALID_CHARS = /^[A-Za-z0-9+@ $!%&()*./#=:;?,'\[\]_^-]*$/;

export class AbaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbaValidationError";
  }
}

export interface AbaHeader {
  /** Approved FI abbreviation of the originating bank, 3 letters (e.g. as advised by your bank). */
  financialInstitution: string;
  /** User name as registered with the bank, up to 26 characters. */
  userName: string;
  /** The 6-digit user identification number allocated by APCA. */
  userId: string;
  /** Description of entries, up to 12 characters (e.g. "PAYROLL"). */
  description: string;
  processingDate: Date;
}

export interface AbaTrace {
  /** Originator's own BSB (nnn-nnn or nnnnnn) and account number, used by the bank to trace the entry. */
  bsb: string;
  accountNumber: string;
  remitterName: string;
}

export interface AbaPayment {
  bsb: string;
  accountNumber: string;
  /** Decimal string in dollars; rounded half-up to cents. */
  amount: string;
  accountTitle: string;
  lodgementReference: string;
}

export interface AbaResult {
  content: string;
  recordCount: number;
  totalCents: string;
  /** Per payment: the exact amount (4dp) minus the amount written to the file (cents), for disclosure. */
  roundingDifference: string;
}

function assertChars(label: string, value: string): void {
  if (!VALID_CHARS.test(value)) {
    throw new AbaValidationError(`${label} contains a character that is not valid in an ABA file.`);
  }
}

function leftPad(label: string, value: string, width: number): string {
  const v = value.trim();
  if (v.length === 0) throw new AbaValidationError(`${label} must not be blank.`);
  if (v.length > width) throw new AbaValidationError(`${label} is longer than ${width} characters.`);
  assertChars(label, v);
  return v.padEnd(width, " ");
}

function normaliseBsb(label: string, bsb: string): string {
  const v = bsb.trim();
  const m = /^(\d{3})-?(\d{3})$/.exec(v);
  if (!m) throw new AbaValidationError(`${label} must be six digits (nnn-nnn).`);
  return `${m[1]}-${m[2]}`;
}

function accountField(label: string, account: string): string {
  const v = account.trim();
  if (!v) throw new AbaValidationError(`${label} must not be blank.`);
  if (!/^[A-Za-z0-9 -]+$/.test(v)) throw new AbaValidationError(`${label} may contain only letters, digits, hyphens and spaces.`);
  if (/^[0 -]*$/.test(v)) throw new AbaValidationError(`${label} must not be all zeros.`);
  if (v.length > 9) throw new AbaValidationError(`${label} is longer than nine characters (remove hyphens if present).`);
  return v.padStart(9, " ");
}

function ddmmyy(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
  return `${dd}${mm}${yy}`;
}

function cents(amount: string): Decimal {
  return new Decimal(amount).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

export function generateAbaFile(header: AbaHeader, trace: AbaTrace, payments: AbaPayment[]): AbaResult {
  if (payments.length === 0) throw new AbaValidationError("There are no payments to put in the file.");
  if (!/^[A-Za-z]{3}$/.test(header.financialInstitution.trim())) {
    throw new AbaValidationError("The financial institution abbreviation must be three letters.");
  }
  if (!/^\d{1,6}$/.test(header.userId.trim())) throw new AbaValidationError("The APCA user id must be up to six digits.");

  const lines: string[] = [];
  lines.push(
    [
      "0",
      " ".repeat(17),
      "01",
      header.financialInstitution.trim().toUpperCase(),
      " ".repeat(7),
      leftPad("User name", header.userName, 26),
      header.userId.trim().padStart(6, "0"),
      leftPad("Description", header.description, 12),
      ddmmyy(header.processingDate),
      " ".repeat(40),
    ].join(""),
  );

  const traceBsb = normaliseBsb("Originator BSB", trace.bsb);
  const traceAccount = accountField("Originator account number", trace.accountNumber);
  const remitter = leftPad("Remitter name", trace.remitterName, 16);

  let total = new Decimal(0);
  let exact = new Decimal(0);
  for (const [i, p] of payments.entries()) {
    const n = i + 1;
    const c = cents(p.amount);
    if (c.lte(0)) throw new AbaValidationError(`Payment ${n} (${p.accountTitle}) must be greater than zero cents.`);
    if (c.gte(new Decimal(10).pow(10))) throw new AbaValidationError(`Payment ${n} is too large for the amount field.`);
    total = total.plus(c);
    exact = exact.plus(new Decimal(p.amount));
    lines.push(
      [
        "1",
        normaliseBsb(`Payment ${n} BSB`, p.bsb),
        accountField(`Payment ${n} account number`, p.accountNumber),
        " ",
        ABA_PAY_TRANSACTION_CODE,
        c.toFixed(0).padStart(10, "0"),
        leftPad(`Payment ${n} account title`, p.accountTitle, 32),
        leftPad(`Payment ${n} lodgement reference`, p.lodgementReference, 18),
        traceBsb,
        traceAccount,
        remitter,
        "0".repeat(8),
      ].join(""),
    );
  }

  const totalStr = total.toFixed(0).padStart(10, "0");
  lines.push(
    ["7", "999-999", " ".repeat(12), totalStr, totalStr, "0".repeat(10), " ".repeat(24), String(payments.length).padStart(6, "0"), " ".repeat(40)].join(""),
  );

  for (const [i, line] of lines.entries()) {
    if (line.length !== ABA_RECORD_LENGTH) {
      throw new Error(`ABA record ${i + 1} is ${line.length} characters, expected ${ABA_RECORD_LENGTH}.`);
    }
  }

  return {
    content: lines.join("\r\n") + "\r\n",
    recordCount: payments.length,
    totalCents: total.toFixed(0),
    roundingDifference: exact.minus(total.dividedBy(100)).toFixed(4),
  };
}
