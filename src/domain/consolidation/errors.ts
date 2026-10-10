import { MAX_ENTITIES_PER_GROUP } from "./types";

/** Not found OR not owned by the caller — deliberately indistinguishable. */
export class GroupNotFoundError extends Error {
  constructor() {
    super("That entity group does not exist.");
    this.name = "GroupNotFoundError";
  }
}

export class GroupNameTakenError extends Error {
  constructor(name: string) {
    super(`You already have an entity group named "${name}".`);
    this.name = "GroupNameTakenError";
  }
}

/** The caller holds no active membership in the organization — says nothing about whether it exists. */
export class NotAMemberOfEntityError extends Error {
  constructor() {
    super("You are not a member of that organization.");
    this.name = "NotAMemberOfEntityError";
  }
}

export class GroupFullError extends Error {
  constructor() {
    super(`An entity group can hold at most ${MAX_ENTITIES_PER_GROUP} entities.`);
    this.name = "GroupFullError";
  }
}

export class EntityAlreadyInGroupError extends Error {
  constructor() {
    super("That entity is already in this group.");
    this.name = "EntityAlreadyInGroupError";
  }
}

export class EntityNotInGroupError extends Error {
  constructor() {
    super("That entity is not in this group.");
    this.name = "EntityNotInGroupError";
  }
}

export class ParentAlreadyExistsError extends Error {
  constructor() {
    super("This group already has a parent entity. Change the existing parent to a subsidiary first.");
    this.name = "ParentAlreadyExistsError";
  }
}

export class InvalidMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMappingError";
  }
}

export class GroupAccountInUseError extends Error {
  constructor() {
    super("That group account is used by an account mapping or an adjustment and cannot be removed.");
    this.name = "GroupAccountInUseError";
  }
}

export class DuplicateGroupAccountError extends Error {
  constructor(type: string, code: string) {
    super(`The group chart already has a ${type.toLowerCase()} account with code ${code}.`);
    this.name = "DuplicateGroupAccountError";
  }
}

export class IntercompanyDesignationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntercompanyDesignationError";
  }
}

export class InvalidAdjustmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAdjustmentError";
  }
}

export class AdjustmentNotFoundError extends Error {
  constructor() {
    super("That adjustment does not exist in this group.");
    this.name = "AdjustmentNotFoundError";
  }
}

export class AdjustmentAlreadyReversedError extends Error {
  constructor() {
    super("That adjustment has already been reversed.");
    this.name = "AdjustmentAlreadyReversedError";
  }
}

export class GroupTooLargeError extends Error {
  constructor() {
    super(`This group has more than ${MAX_ENTITIES_PER_GROUP} entities, which is the most a consolidated report will build.`);
    this.name = "GroupTooLargeError";
  }
}

/**
 * Raised instead of adding up unlike currencies. There is no tested
 * exchange-rate translation in this codebase (the `exchange_rates` table is
 * unused), so consolidation supports single-base-currency groups only and says
 * so specifically. Lists only the currencies of entities the user can actually
 * consolidate — never one belonging to an entity they cannot access.
 */
export class MixedCurrencyError extends Error {
  readonly currencies: string[];
  constructor(currencies: string[]) {
    const sorted = [...currencies].sort();
    super(
      `These entities have different base currencies: ${sorted.join(", ")} — currency translation is not yet supported. ` +
        `Consolidate entities that share one base currency.`,
    );
    this.name = "MixedCurrencyError";
    this.currencies = sorted;
  }
}
