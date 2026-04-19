// Handler for bulk_edit_expense: apply a batch of edit_expense operations in one call.

import QuickBooks from "node-quickbooks";
import { handleEditExpense } from "./expense.js";

interface ExpenseLineChange {
  line_id?: string;
  account_name?: string;
  amount?: number;
  description?: string;
  delete?: boolean;
}

interface ExpenseEdit {
  id: string;
  txn_date?: string;
  memo?: string;
  payment_account?: string;
  department_name?: string;
  entity_name?: string;
  entity_id?: string;
  lines?: ExpenseLineChange[];
}

interface ItemResult {
  id: string;
  ok: boolean;
  text: string;
}

export async function handleBulkEditExpense(
  client: QuickBooks,
  args: {
    edits: ExpenseEdit[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { edits, draft = true } = args;

  if (!edits || edits.length === 0) {
    throw new Error("edits array is required and must contain at least one item");
  }

  // Process sequentially. QBO updates carry SyncTokens and we want deterministic ordering
  // and clear per-item error attribution. Running in parallel can also trip rate limits.
  const results: ItemResult[] = [];
  for (const edit of edits) {
    if (!edit.id) {
      results.push({ id: "(missing)", ok: false, text: "Missing required field: id" });
      continue;
    }
    try {
      const res = await handleEditExpense(client, { ...edit, draft });
      const text = res.content.map((c) => c.text).join("\n");
      results.push({ id: edit.id, ok: true, text });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ id: edit.id, ok: false, text: msg });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;

  const header = draft
    ? `DRAFT - Bulk Expense Edit Preview (${results.length} items)`
    : `Bulk Expense Edit Results (${results.length} items)`;

  const summary = [
    header,
    "",
    `Successful: ${okCount}`,
    `Failed: ${failCount}`,
    "",
    "Per-item:",
  ];

  for (const r of results) {
    const status = r.ok ? "OK" : "ERROR";
    summary.push("");
    summary.push(`--- Expense ${r.id} [${status}] ---`);
    summary.push(r.text);
  }

  if (draft) {
    summary.push("");
    summary.push("Set draft=false to apply all edits. Note: failed validations above will not be retried automatically; fix and resubmit only the failing ids.");
  }

  return {
    content: [{ type: "text", text: summary.join("\n") }],
  };
}
