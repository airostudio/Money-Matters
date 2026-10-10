import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import {
  DimensionService,
  DuplicateDimensionKeyError,
  DuplicateDimensionValueError,
} from "@/domain/dimensions/dimension-service";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("DimensionService (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("dimensions");
    owner = org.owner;
  });

  it("creates a dimension, slugifying its key from the name", async () => {
    const dimension = await DimensionService.createDimension(owner, { name: "Project" });
    expect(dimension.key).toBe("project");
    expect(dimension.isActive).toBe(true);
    expect(dimension.values).toEqual([]);
  });

  it("rejects a duplicate dimension key in the same organization", async () => {
    await DimensionService.createDimension(owner, { name: "Project" });
    await expect(DimensionService.createDimension(owner, { name: "project" })).rejects.toThrow(
      DuplicateDimensionKeyError,
    );
  });

  it("adds values to a dimension and lists them with it", async () => {
    const dimension = await DimensionService.createDimension(owner, { name: "Location" });
    await DimensionService.addValue(owner, dimension.id, { label: "Sydney" });
    await DimensionService.addValue(owner, dimension.id, { label: "Melbourne" });

    const list = await DimensionService.list(owner);
    const found = list.find((d) => d.id === dimension.id);
    expect(found?.values.map((v) => v.label).sort()).toEqual(["Melbourne", "Sydney"]);
  });

  it("rejects a duplicate value within the same dimension", async () => {
    const dimension = await DimensionService.createDimension(owner, { name: "Location" });
    await DimensionService.addValue(owner, dimension.id, { label: "Sydney" });
    await expect(DimensionService.addValue(owner, dimension.id, { label: "sydney" })).rejects.toThrow(
      DuplicateDimensionValueError,
    );
  });

  it("listActive excludes inactive dimensions and inactive values", async () => {
    const dimension = await DimensionService.createDimension(owner, { name: "Project" });
    const value = await DimensionService.addValue(owner, dimension.id, { label: "Website Rebuild" });
    await DimensionService.setValueActive(owner, value.id, false);

    const active = await DimensionService.listActive(owner);
    const found = active.find((d) => d.id === dimension.id);
    expect(found?.values).toHaveLength(0);

    await DimensionService.setDimensionActive(owner, dimension.id, false);
    const activeAfterDeactivation = await DimensionService.listActive(owner);
    expect(activeAfterDeactivation.some((d) => d.id === dimension.id)).toBe(false);
  });

  it("denies dimension:manage mutations to a role that only holds dimension:read", async () => {
    const readOnlyActor: Actor = { ...owner, role: "READ_ONLY" };
    await expect(DimensionService.createDimension(readOnlyActor, { name: "Project" })).rejects.toThrow(
      PermissionDeniedError,
    );
    // READ_ONLY still holds dimension:read, so listing itself is allowed.
    await expect(DimensionService.list(readOnlyActor)).resolves.toEqual([]);
  });

  it("getValueWithDimension resolves a value id back to its parent dimension's key and name", async () => {
    const dimension = await DimensionService.createDimension(owner, { name: "Project" });
    const value = await DimensionService.addValue(owner, dimension.id, { label: "Website Rebuild" });

    const resolved = await DimensionService.getValueWithDimension(owner, value.id);
    expect(resolved).toMatchObject({ dimensionKey: "project", dimensionName: "Project", label: "Website Rebuild" });
  });
});
