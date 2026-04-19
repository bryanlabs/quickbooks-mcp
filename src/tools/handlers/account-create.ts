// Handler for create_account tool

import QuickBooks from "node-quickbooks";
import { promisify, getAccountCache, clearLookupCache } from "../../client/index.js";
import { outputReport } from "../../utils/index.js";

interface QBAccount {
  Id: string;
  SyncToken: string;
  Name: string;
  FullyQualifiedName?: string;
  AccountType?: string;
  AccountSubType?: string;
  Classification?: string;
  Description?: string;
  AcctNum?: string;
  SubAccount?: boolean;
  ParentRef?: { value: string; name?: string };
  Active?: boolean;
  CurrentBalance?: number;
  CurrencyRef?: { value: string; name?: string };
}

export async function handleCreateAccount(
  client: QuickBooks,
  args: {
    name: string;
    account_type: string;
    account_sub_type?: string;
    description?: string;
    acct_num?: string;
    parent_account_name?: string;
    parent_account_id?: string;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    name,
    account_type,
    account_sub_type,
    description,
    acct_num,
    parent_account_name,
    parent_account_id,
    draft = true,
  } = args;

  // Build the account object per QBO API v3 Account schema
  const accountObj: Record<string, unknown> = {
    Name: name,
    AccountType: account_type,
  };

  if (account_sub_type) accountObj.AccountSubType = account_sub_type;
  if (description) accountObj.Description = description;
  if (acct_num) accountObj.AcctNum = acct_num;

  // Resolve parent account, either explicit ID or by name lookup
  let parentInfo: { id: string; name: string; accountType?: string } | undefined;
  if (parent_account_id) {
    const cache = await getAccountCache(client);
    const match = cache.items.find((a) => a.Id === parent_account_id);
    if (!match) {
      throw new Error(`Parent account not found by ID: ${parent_account_id}`);
    }
    parentInfo = { id: match.Id, name: match.Name, accountType: match.AccountType };
  } else if (parent_account_name) {
    const cache = await getAccountCache(client);
    // Match by FullyQualifiedName first, then Name
    const match =
      cache.items.find((a) => a.FullyQualifiedName === parent_account_name) ||
      cache.items.find((a) => a.Name === parent_account_name);
    if (!match) {
      const names = cache.items.map((a) => a.FullyQualifiedName || a.Name).slice(0, 20).join(", ");
      throw new Error(
        `Parent account not found: "${parent_account_name}". First 20 available: ${names}`
      );
    }
    parentInfo = { id: match.Id, name: match.FullyQualifiedName || match.Name, accountType: match.AccountType };
  }

  if (parentInfo) {
    accountObj.SubAccount = true;
    accountObj.ParentRef = { value: parentInfo.id };
    // QBO requires child AccountType to match parent. Warn if user passed a different one.
    if (parentInfo.accountType && parentInfo.accountType !== account_type) {
      throw new Error(
        `Child account_type "${account_type}" must match parent account type "${parentInfo.accountType}". QBO rejects sub-accounts with a different AccountType than their parent.`
      );
    }
  }

  if (draft) {
    const preview = [
      "DRAFT - Account Preview",
      "",
      `Name: ${name}`,
      `Account Type: ${account_type}`,
      `Account Sub Type: ${account_sub_type || "(auto)"}`,
      `Description: ${description || "(none)"}`,
      `Account Number: ${acct_num || "(none)"}`,
      `Parent: ${parentInfo ? `${parentInfo.name} (id ${parentInfo.id})` : "(none - top-level account)"}`,
      `Sub-account: ${parentInfo ? "yes" : "no"}`,
      "",
      "Set draft=false to create this account.",
    ].join("\n");

    return { content: [{ type: "text", text: preview }] };
  }

  const result = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).createAccount(accountObj, cb)
  ) as QBAccount;

  // Invalidate the lookup cache so subsequent name-based resolutions (e.g. in
  // edit_expense, create_journal_entry) can see the newly created account.
  clearLookupCache();

  const qboUrl = `https://app.qbo.intuit.com/app/chartofaccounts`;

  const lines = [
    "Account Created!",
    "",
    `ID: ${result.Id}`,
    `Name: ${result.Name}`,
    `Fully Qualified Name: ${result.FullyQualifiedName || result.Name}`,
    `Account Type: ${result.AccountType || account_type}`,
    `Account Sub Type: ${result.AccountSubType || "(default)"}`,
    `Classification: ${result.Classification || "(derived)"}`,
    ...(result.SubAccount && result.ParentRef
      ? [`Parent: ${result.ParentRef.name || result.ParentRef.value}`]
      : ["Sub-account: no"]),
    `Active: ${result.Active !== false}`,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return outputReport("account-create", result, lines);
}
