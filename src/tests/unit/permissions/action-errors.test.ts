import { describe, expect, it } from "vitest";
import { rethrowPermissionDenied } from "@/lib/action-errors";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";

describe("rethrowPermissionDenied (server-action catch-all)", () => {
  it("turns a permission refusal into a redirect to the friendly access-denied page", () => {
    let thrown: unknown;
    try {
      rethrowPermissionDenied(new PermissionDeniedError("customer_invoice:post", "READ_ONLY"), "acme");
    } catch (e) {
      thrown = e;
    }
    const digest = (thrown as { digest?: string }).digest ?? "";
    expect(digest).toContain("NEXT_REDIRECT");
    expect(digest).toContain("/acme/access-denied?permission=customer_invoice%3Apost");
  });

  it("rethrows every other error untouched, so real failures are never hidden", () => {
    const boom = new Error("boom");
    expect(() => rethrowPermissionDenied(boom, "acme")).toThrow(boom);
  });
});
