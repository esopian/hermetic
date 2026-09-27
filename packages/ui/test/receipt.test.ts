/**
 * §4.6: the teardown receipt is what the operator reads *after* the fleet is
 * gone, so the order of its groups is the order of the questions they ask —
 * what went, then what is still in the account, then what only they can do.
 */
import { describe, expect, test } from "bun:test";
import type { TeardownReceipt, TeardownResourceOutcome } from "../src/api/index.ts";
import { GROUP_ORDER, GROUP_TITLES, groupReceipt, receiptFlags } from "../src/logic/receipt.ts";

function outcome(overrides: Partial<TeardownResourceOutcome> = {}): TeardownResourceOutcome {
  return {
    phase: "stack",
    disposition: "removed",
    what: "a thing",
    count: null,
    detail: null,
    ...overrides,
  };
}

function receipt(overrides: Partial<TeardownReceipt> = {}): TeardownReceipt {
  return {
    id: "r-1",
    op_id: "op-1",
    started_at: "2026-09-03T05:09:00.000Z",
    finished_at: "2026-09-03T05:09:36.000Z",
    account_id: "123456789012",
    region: "us-east-1",
    fleet_id: "fxtr0001",
    stack_name: "hermetic-fxtr0001",
    options: { purge: true, delete_snapshots: false, delete_volumes: false, reset_local: true },
    outcome: "ok",
    error: null,
    resources: [],
    events: [],
    ...overrides,
  };
}

describe("groupReceipt", () => {
  test("removed comes first, and empty groups are not rendered at all", () => {
    const groups = groupReceipt(
      receipt({
        resources: [
          outcome({ disposition: "manual", what: "the Tailscale OAuth client" }),
          outcome({ disposition: "removed", what: "the hermetic-fxtr0001 stack" }),
          outcome({ disposition: "retained", what: "EBS volumes" }),
        ],
      }),
    );
    expect(groups.map((g) => g.disposition)).toEqual(["removed", "retained", "manual"]);
    expect(groups[0]!.items[0]!.what).toBe("the hermetic-fxtr0001 stack");
  });

  test("every group has a title, so no disposition can render unlabelled", () => {
    for (const disposition of GROUP_ORDER) {
      expect(GROUP_TITLES[disposition]).toBeString();
    }
  });

  test("a receipt with nothing in it renders no groups rather than five empty ones", () => {
    expect(groupReceipt(receipt())).toEqual([]);
  });

  test("items keep their counts and their reasons", () => {
    const groups = groupReceipt(
      receipt({
        resources: [
          outcome({
            disposition: "retained",
            what: "EBS volumes tagged hermetic:managed=true",
            count: 3,
            detail: "`--delete-volumes` would have removed them",
          }),
        ],
      }),
    );
    expect(groups[0]!.items[0]).toMatchObject({ count: 3 });
    expect(groups[0]!.items[0]!.detail).toContain("--delete-volumes");
  });
});

describe("receiptFlags", () => {
  test("reads back as the flags the teardown ran with", () => {
    expect(receiptFlags(receipt())).toEqual(["--purge", "--reset-local"]);
  });

  test("a teardown that took every default lists none", () => {
    expect(
      receiptFlags(
        receipt({
          options: { purge: false, delete_snapshots: false, delete_volumes: false, reset_local: false },
        }),
      ),
    ).toEqual([]);
  });
});
