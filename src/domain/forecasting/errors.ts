export class ScenarioNotFoundError extends Error {
  constructor(id: string) {
    super(`Scenario ${id} was not found in this organization.`);
    this.name = "ScenarioNotFoundError";
  }
}

/** A scenario's typed parameters failed validation (malformed, missing, or out of range). */
export class InvalidScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScenarioError";
  }
}

/**
 * A scenario can't be run because the data it needs doesn't exist — e.g. a
 * budget-based baseline with no ACTIVE budget, or LOSE_CUSTOMER with no
 * customer revenue history to pick a "largest customer" from. Never papered
 * over with an invented default.
 */
export class ScenarioBaselineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioBaselineUnavailableError";
  }
}

export class InvalidForecastSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidForecastSettingError";
  }
}
