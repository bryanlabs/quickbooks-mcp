// Handlers for expense tools (get, edit)

import QuickBooks from "node-quickbooks";
import {
  promisify,
  getAccountCache,
  getDepartmentCache,
} from "../../client/index.js";
import { writeReport, validateAmount, toDollars } from "../../utils/index.js";

interface ExpenseLineChange {
  line_id?: string;
  account_name?: string;
  amount?: number;
  description?: string;
  delete?: boolean;
}

export async function handleGetExpense(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const expense = await promisify<unknown>((cb) =>
    client.getPurchase(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    PaymentType: string;
    DocNumber?: string;
    PrivateNote?: string;
    TotalAmt?: number;
    AccountRef?: { value: string; name?: string };
    EntityRef?: { value: string; name?: string; type?: string };
    DepartmentRef?: { value: string; name?: string };
    Line?: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      AccountBasedExpenseLineDetail?: {
        AccountRef: { value: string; name?: string };
        DepartmentRef?: { value: string; name?: string };
      };
      ItemBasedExpenseLineDetail?: {
        ItemRef: { value: string; name?: string };
        Qty?: number;
        UnitPrice?: number;
      };
    }>;
  };
  const qboUrl = `https://app.qbo.intuit.com/app/expense?txnId=${expense.Id}`;

  // Write full object to file
  const filepath = writeReport(`expense-${expense.Id}`, expense);

  // Format summary
  const lines: string[] = [
    'Expense (Purchase)',
    '==================',
    `ID: ${expense.Id}`,
    `SyncToken: ${expense.SyncToken}`,
    `Payment Type: ${expense.PaymentType}`,
    `Payment Account: ${expense.AccountRef?.name || expense.AccountRef?.value || '(none)'}`,
    `Payee: ${expense.EntityRef?.name || expense.EntityRef?.value || '(none)'}`,
    `Department: ${expense.DepartmentRef?.name || expense.DepartmentRef?.value || '(none)'}`,
    `Date: ${expense.TxnDate}`,
    `Ref no.: ${expense.DocNumber || '(none)'}`,
    `Memo: ${expense.PrivateNote || '(none)'}`,
    `Total: $${(expense.TotalAmt || 0).toFixed(2)}`,
    '',
    'Lines:',
  ];

  for (const line of expense.Line || []) {
    if (line.AccountBasedExpenseLineDetail) {
      const detail = line.AccountBasedExpenseLineDetail;
      const acctName = detail.AccountRef.name || detail.AccountRef.value;
      const deptStr = detail.DepartmentRef?.name ? ` [${detail.DepartmentRef.name}]` : '';
      const descStr = line.Description ? ` "${line.Description}"` : '';
      lines.push(`  Line ${line.Id}: ${acctName}${deptStr} $${line.Amount.toFixed(2)}${descStr}`);
    } else if (line.ItemBasedExpenseLineDetail) {
      const detail = line.ItemBasedExpenseLineDetail;
      const itemName = detail.ItemRef.name || detail.ItemRef.value;
      const descStr = line.Description ? ` "${line.Description}"` : '';
      lines.push(`  Line ${line.Id}: Item: ${itemName} (Qty: ${detail.Qty || 1}) $${line.Amount.toFixed(2)}${descStr}`);
    }
  }

  lines.push('');
  lines.push(`View in QuickBooks: ${qboUrl}`);
  lines.push(`Full data: ${filepath}`);

  return {
    content: [{ type: "text", text: lines.join('\n') }],
  };
}

export async function handleEditExpense(
  client: QuickBooks,
  args: {
    id: string;
    txn_date?: string;
    memo?: string;
    payment_account?: string;
    department_name?: string;
    lines?: ExpenseLineChange[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id, txn_date, memo, payment_account, department_name, lines: lineChanges, draft = true } = args;

  // Fetch current Purchase
  const current = await promisify<unknown>((cb) =>
    client.getPurchase(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    PaymentType: string;
    PrivateNote?: string;
    AccountRef?: { value: string; name?: string };
    EntityRef?: { value: string; name?: string; type?: string };
    DepartmentRef?: { value: string; name?: string };
    Line: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      AccountBasedExpenseLineDetail?: {
        AccountRef: { value: string; name?: string };
        DepartmentRef?: { value: string; name?: string };
      };
    }>;
  };

  // Determine if we're modifying lines - requires full update (not sparse)
  const needsFullUpdate = lineChanges && lineChanges.length > 0;

  // Build updated Purchase
  // Note: PaymentType is required by QB API even for sparse updates
  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    PaymentType: current.PaymentType,
  };

  // Only use sparse for non-line updates; full update needed for line modifications
  // Note: node-quickbooks auto-sets sparse=true, so we must explicitly set sparse=false for full updates
  if (!needsFullUpdate) {
    updated.sparse = true;
  } else {
    // Full update: explicitly set sparse=false (node-quickbooks defaults to true)
    updated.sparse = false;
    updated.TxnDate = current.TxnDate;
    updated.PrivateNote = current.PrivateNote;
    if (current.AccountRef) {
      updated.AccountRef = current.AccountRef;
    }
    if (current.EntityRef) {
      updated.EntityRef = current.EntityRef;
    }
    if (current.DepartmentRef) {
      updated.DepartmentRef = current.DepartmentRef;
    }
    // Copy lines and strip read-only fields
    updated.Line = current.Line.map(line => {
      const { LineNum, ...rest } = line as Record<string, unknown>;
      return rest;
    });
  }

  if (txn_date !== undefined) updated.TxnDate = txn_date;
  if (memo !== undefined) updated.PrivateNote = memo;

  // Resolve payment account if provided
  if (payment_account !== undefined) {
    const acctCache = await getAccountCache(client);
    let match = acctCache.byAcctNum.get(payment_account.toLowerCase());
    if (!match) match = acctCache.byName.get(payment_account.toLowerCase());
    if (!match) match = acctCache.items.find(a =>
      a.FullyQualifiedName?.toLowerCase().includes(payment_account.toLowerCase())
    );
    if (!match) throw new Error(`Payment account not found: "${payment_account}"`);
    updated.AccountRef = { value: match.Id, name: match.FullyQualifiedName || match.Name };
  }

  // Resolve header-level department if provided
  if (department_name !== undefined) {
    const deptCache = await getDepartmentCache(client);
    let match = deptCache.byName.get(department_name.toLowerCase());
    if (!match) match = deptCache.items.find(d =>
      d.FullyQualifiedName?.toLowerCase().includes(department_name.toLowerCase())
    );
    if (!match) throw new Error(`Department not found: "${department_name}"`);
    updated.DepartmentRef = { value: match.Id, name: match.FullyQualifiedName || match.Name };
  }

  // Process line changes if provided
  // Use updated.Line if available (for full updates with stripped read-only fields), else current.Line
  let finalLines = [...((updated.Line as typeof current.Line) || current.Line)];

  if (lineChanges && lineChanges.length > 0) {
    const acctCache = await getAccountCache(client);

    const resolveAcct = (name: string) => {
      let match = acctCache.byAcctNum.get(name.toLowerCase());
      if (!match) match = acctCache.byName.get(name.toLowerCase());
      if (!match) match = acctCache.items.find(a =>
        a.FullyQualifiedName?.toLowerCase().includes(name.toLowerCase())
      );
      if (!match) throw new Error(`Account not found: "${name}"`);
      return { value: match.Id, name: match.FullyQualifiedName || match.Name };
    };

    for (const change of lineChanges) {
      if (change.line_id) {
        const lineIndex = finalLines.findIndex(l => l.Id === change.line_id);
        if (lineIndex === -1) {
          throw new Error(`Line ID ${change.line_id} not found in expense`);
        }

        if (change.delete) {
          finalLines.splice(lineIndex, 1);
        } else {
          const line = { ...finalLines[lineIndex] };
          const detail = { ...(line.AccountBasedExpenseLineDetail || {}) } as {
            AccountRef: { value: string; name?: string };
            DepartmentRef?: { value: string; name?: string };
          };

          if (change.amount !== undefined) {
            const amountCents = validateAmount(change.amount, `Line ${change.line_id}`);
            line.Amount = toDollars(amountCents);
          }
          if (change.description !== undefined) line.Description = change.description;
          if (change.account_name !== undefined) detail.AccountRef = resolveAcct(change.account_name);

          line.AccountBasedExpenseLineDetail = detail;
          line.DetailType = 'AccountBasedExpenseLineDetail';
          finalLines[lineIndex] = line;
        }
      } else {
        if (!change.amount || !change.account_name) {
          throw new Error('New lines require amount and account_name');
        }

        // Validate and normalize the amount
        const amountCents = validateAmount(change.amount, `New line for ${change.account_name}`);

        // Id omitted for new lines - QB will assign
        const newLine = {
          Amount: toDollars(amountCents),
          Description: change.description,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: resolveAcct(change.account_name),
          }
        } as typeof finalLines[0];
        finalLines.push(newLine);
      }
    }

    updated.Line = finalLines;
  }

  const qboUrl = `https://app.qbo.intuit.com/app/expense?txnId=${id}`;

  if (draft) {
    const previewLines: string[] = [
      'DRAFT - Expense Edit Preview',
      '',
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      `Payment Type: ${current.PaymentType} (cannot be changed)`,
      '',
      'Changes:',
    ];

    if (txn_date !== undefined) previewLines.push(`  Date: ${current.TxnDate} → ${txn_date}`);
    if (memo !== undefined) previewLines.push(`  Memo: ${current.PrivateNote || '(none)'} → ${memo}`);
    if (payment_account !== undefined) {
      const newAcct = (updated.AccountRef as { name?: string })?.name || payment_account;
      previewLines.push(`  Payment Account: ${current.AccountRef?.name || '(none)'} → ${newAcct}`);
    }
    if (department_name !== undefined) {
      const newDept = (updated.DepartmentRef as { name?: string })?.name || department_name;
      previewLines.push(`  Department: ${current.DepartmentRef?.name || '(none)'} → ${newDept}`);
    }

    if (updated.Line) {
      previewLines.push('');
      previewLines.push('Updated Lines:');
      for (const line of updated.Line as typeof finalLines) {
        const detail = line.AccountBasedExpenseLineDetail;
        if (detail) {
          const acctName = detail.AccountRef.name || detail.AccountRef.value;
          const deptStr = detail.DepartmentRef?.name ? ` [${detail.DepartmentRef.name}]` : '';
          previewLines.push(`  ${acctName}${deptStr}: $${line.Amount.toFixed(2)}`);
        }
      }
    }

    previewLines.push('');
    previewLines.push('Set draft=false to apply these changes.');

    return {
      content: [{ type: "text", text: previewLines.join('\n') }],
    };
  }

  const result = await promisify<unknown>((cb) =>
    client.updatePurchase(updated, cb)
  ) as { Id: string; SyncToken: string };

  return {
    content: [{ type: "text", text: `Expense ${id} updated successfully.\nNew SyncToken: ${result.SyncToken}\nView in QuickBooks: ${qboUrl}` }],
  };
}
