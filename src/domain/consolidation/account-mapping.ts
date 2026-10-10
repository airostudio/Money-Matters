import type { AccountType } from "@/domain/accounts/account-service";
import type { AccountMappingDef, GroupAccountDef } from "./types";

/**
 * Account-mapping rule (docs/accounting-engine.md section 9). Charts of
 * accounts are per organization and do not line up on their own, so every
 * entity account is resolved to a GROUP ACCOUNT — a line of the group's own
 * chart of accounts — by, in order:
 *
 *  1. an EXPLICIT mapping (entity account -> group account) the user set,
 *     provided the group account's type still equals the entity account's type
 *     (a stale mapping across types is treated as unmapped rather than letting
 *     a liability land in a revenue line);
 *  2. the DEFAULT rule: the group account with the same type AND the same
 *     account code;
 *  3. otherwise UNMAPPED — shown in an explicit "Unmapped <type>" bucket, still
 *     counted in the consolidated total. Never dropped, never silently merged
 *     into some other line.
 *
 * Same code with a different type (1500 an asset in A, an expense in B) is
 * deliberately NOT a match: type is part of the key.
 */
export type AccountResolution =
  | { kind: "MAPPED"; groupAccount: GroupAccountDef; via: "EXPLICIT" | "DEFAULT" }
  | { kind: "UNMAPPED" };

export interface ResolvableAccount {
  accountId: string;
  code: string;
  type: AccountType;
}

export function createAccountResolver(groupAccounts: GroupAccountDef[], mappings: AccountMappingDef[]) {
  const byId = new Map(groupAccounts.map((g) => [g.id, g]));
  const byTypeCode = new Map(groupAccounts.map((g) => [`${g.type}|${g.code}`, g]));
  const explicit = new Map(mappings.map((m) => [`${m.organizationId}|${m.accountId}`, m.groupAccountId]));

  return function resolve(organizationId: string, account: ResolvableAccount): AccountResolution {
    const mappedId = explicit.get(`${organizationId}|${account.accountId}`);
    if (mappedId) {
      const target = byId.get(mappedId);
      if (target && target.type === account.type) return { kind: "MAPPED", groupAccount: target, via: "EXPLICIT" };
      return { kind: "UNMAPPED" };
    }
    const byDefault = byTypeCode.get(`${account.type}|${account.code}`);
    if (byDefault) return { kind: "MAPPED", groupAccount: byDefault, via: "DEFAULT" };
    return { kind: "UNMAPPED" };
  };
}

export type AccountResolver = ReturnType<typeof createAccountResolver>;
