export class BudgetNotFoundError extends Error {
  constructor(id: string) {
    super(`Budget ${id} was not found in this organization.`);
    this.name = "BudgetNotFoundError";
  }
}

export class InvalidBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBudgetError";
  }
}

/**
 * Thrown by `BudgetService.activate` when activating a BASELINE budget
 * would leave two ACTIVE BASELINE budgets overlapping the same period in
 * the same org — see `budgets` table's doc comment in src/db/schema.ts for
 * why this is the one structurally-enforced rule in this slice.
 */
export class OverlappingActiveBaselineError extends Error {
  constructor(conflictingBudgetName: string) {
    super(
      `Another ACTIVE baseline budget ("${conflictingBudgetName}") already covers an overlapping period. ` +
        `Archive it first, or use a REVISED_FORECAST/ROLLING_FORECAST instead.`,
    );
    this.name = "OverlappingActiveBaselineError";
  }
}

/** A mutation was attempted against a budget that isn't DRAFT — editing lines requires DRAFT; see `BudgetService`'s doc comment. */
export class BudgetNotEditableError extends Error {
  constructor(name: string, status: string) {
    super(`Budget "${name}" is ${status}, not DRAFT — its lines cannot be edited. Create a new revision instead.`);
    this.name = "BudgetNotEditableError";
  }
}
