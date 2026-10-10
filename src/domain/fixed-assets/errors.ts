export class FixedAssetClassNotFoundError extends Error {
  constructor(id: string) {
    super(`Fixed asset class ${id} was not found in this organization.`);
    this.name = "FixedAssetClassNotFoundError";
  }
}

export class InvalidFixedAssetClassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFixedAssetClassError";
  }
}

export class FixedAssetNotFoundError extends Error {
  constructor(id: string) {
    super(`Fixed asset ${id} was not found in this organization.`);
    this.name = "FixedAssetNotFoundError";
  }
}

export class InvalidFixedAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFixedAssetError";
  }
}

/**
 * Thrown by `registerFromBillLine` when the referenced bill (or bill line)
 * isn't in a state that can be trusted to already have posted the
 * acquisition debit — see `FixedAssetService`'s doc comment for why this
 * path never posts anything itself.
 */
export class InvalidAcquisitionSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAcquisitionSourceError";
  }
}

/**
 * A mutation was attempted against an asset that isn't `ACTIVE` — disposal,
 * write-off, and depreciation all require it, and once an asset leaves
 * `ACTIVE` it is terminal (see `fixedAssetStatusEnum`'s doc comment in
 * src/db/schema.ts).
 */
export class FixedAssetNotActiveError extends Error {
  constructor(name: string, status: string) {
    super(`Fixed asset "${name}" is ${status}, not ACTIVE — this action is not available.`);
    this.name = "FixedAssetNotActiveError";
  }
}

export class InvalidDepreciationRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDepreciationRunError";
  }
}

export class InvalidDisposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDisposalError";
  }
}
