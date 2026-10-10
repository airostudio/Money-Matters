# Operations runbook

Manual procedures that are deliberately **not** available inside the application. Nothing here is automated, and no script for it ships in this repository.

## 1. Permanently deleting an organization (manual, DBA-level, irreversible)

> **Read this whole section before doing anything. This is a destructive, irreversible operation on accounting records. It is not part of the product and the application will never do it for you.**

### Why the app cannot, and why that is intended

Deleting a ledger is the one thing this system is designed to prevent. The application connects as the restricted role `mm_app`, which has **no `DELETE` grant** on `organizations`, on the ledger tables, or on the append-only tables
(`audit_logs`, `platform_admin_audit_logs`, `webhook_delivery_attempts`, period-lock events, ...). That is enforced by the database, tested as the real role (`invite-index.test.ts`, `ledger` and audit tests), and is not something to "fix" with a
privileged application connection - **do not add one**. What the application offers is **archive**: reversible, loses nothing, closes the company to everyone (`docs/security.md` section 17). For almost every real situation (a business that closed,
a customer who left, a test company, a duplicate) archive is the right answer, and an archived company costs nothing but storage.

### When permanent deletion might be legitimate

Only when you have a legal or contractual obligation to erase a specific customer's data (for example a verified erasure request that is not overridden by record-keeping law - accounting records are usually **required** to be retained for years,
check with the customer's jurisdiction and your own counsel first), or to remove a company created in error that holds no real records. Archive first, always; decide about erasure later, on advice.

### Warnings

1. **Back up first.** Take a verified, restorable backup of the whole database (and confirm you can restore it into a scratch database) *before* any deletion. There is no undo.
2. **It is irreversible.** Deleted journals, invoices, bank data, payroll and documents cannot be reconstructed. Exports are the only copy: have the customer export their reports (each report page has a CSV export) and keep the export where the law requires.
3. **The audit tables are deliberately protected.** `audit_logs` and the other append-only tables refuse `DELETE` for the application role. Removing a company's audit trail is the most consequential part of erasure: it destroys the evidence of what
   happened to that company's books. Make that a separate, explicit, documented decision with a named approver - not a side effect.
4. **Platform records outlive the company.** `platform_admin_audit_logs` stores the organization id as plain data (not a foreign key) and is append-only; it will still mention the organization id and name snapshots after the company is gone. Decide whether that is acceptable for your obligation.
5. **People are shared across companies.** Users (logins) belong to no single company. Deleting a company must never delete a user who is a member of another company; check each member's other memberships first. A user's own identity is a separate erasure decision.
6. **Practices and consolidation groups reference companies.** A practice's client link and a consolidation group's entity entry point at the organization id; sort those out deliberately (the practice and group owners should know), do not leave dangling references.
7. **Secrets and external systems.** The company's API keys stop working with it, and its webhook subscriptions (which hold encrypted signing secrets) go away; tell the customer's integrators. Nothing in this system emails them.
8. **Do it in a maintenance window, in a transaction, on a connection that is not the application's.** Use a role that owns the schema (the migration role), never `mm_app`, and never grant `mm_app` anything to make this easier. Run the changes inside a single transaction so a mistake can be rolled back before commit,
   and verify row counts against what you expect *before* committing.
9. **Stop and ask if anything surprises you** - an unexpected foreign-key error means a table you have not accounted for still refers to the company. Do not reach for `CASCADE`/`TRUNCATE` shortcuts to make an error go away.

### What to do instead, in order

1. Archive the company in the app (Settings -> Danger zone by an Owner, or the platform admin from `/admin/organizations/<id>` with a reason). Confirm the customer has exported what they need.
2. If erasure is still required after advice, plan it as a change request: who approves, which jurisdiction's retention rules apply, what is kept (for example an export held under legal hold), what happens to the audit trail.
3. Have a DBA perform it manually per the warnings above, with a tested backup, in a transaction, and record what was done and by whom outside this system.

There is intentionally no SQL in this document. Writing the exact statements for your schema version, against a restored backup first, is part of doing this safely.
