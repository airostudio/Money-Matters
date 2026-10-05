/**
 * The ONE definition of "the same email address". Registration, sign-in,
 * add-member and the platform-admin identity gate all normalise through this,
 * and the database enforces the result (users_email_normalised CHECK +
 * users_email_lower_unique index, drizzle/0035_*.sql) — so two accounts that
 * differ only by case/whitespace cannot coexist, and a look-alike of a
 * privileged address can never pass an email comparison.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
