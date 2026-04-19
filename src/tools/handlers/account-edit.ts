// Handler for edit_account tool

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

export async function handleEditAccount(
  client: QuickBooks,
  args: {
    id: string;
    name?: string;
    description?: string;
    acct_num?: string;
    active?: boolean;
    parent_account_name?: string;
    parent_account_id?: string;
    clear_parent?: boolean;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    id,
    name,
    description,
    acct_num,
    active,
    parent_account_name,
    parent_account_id,
    clear_parent,
    draft = true,
  } = args;

  // Fetch current account state (sparse updates still require SyncToken).
  const current = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).getAccount(id, cb)
  ) as QBAccount;

  if (!current || !current.Id) {
    throw new Error(`Account not found: ${id}`);
  }

  // Build the update payload. QBO Account updates use full-object replace by
  // default; include sparse=true so we only overwrite the fields we provide.
  const update: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    sparse: true,
  };

  // Required: Name is mandatory on any Account update. Include the current
  // one if not changing it so QBO doesn't reject the payload.
  update.Name = name ?? current.Name;
  // AccountType must also be present or QBO rejects the request.
  if (current.AccountType) update.AccountType = current.AccountType;

  if (description !== undefined) update.Description = description;
  if (acct_num !== undefined) update.AcctNum = acct_num;
  if (active !== undefined) update.Active = active;

  let parentInfo: { id: string; name: string; accountType?: string } | undefined;
  if (clear_parent) {
    update.SubAccount = false;
    update.ParentRef = null;
  } else if (parent_account_id || parent_account_name) {
    const cache = await getAccountCache(client);
    if (parent_account_id) {
      const match = cache.items.find((a) => a.Id === parent_account_id);
      if (!match) {
        throw new Error(`Parent account not found by ID: ${parent_account_id}`);
      }
      parentInfo = { id: match.Id, name: match.Name, accountType: match.AccountType };
    } else {
      const match =
        cache.items.find((a) => a.FullyQualifiedName === parent_account_name) ||
        cache.items.find((a) => a.Name === parent_account_name);
      if (!match) {
        throw new Error(`Parent account not found: "${parent_account_name}"`);
      }
      parentInfo = { id: match.Id, name: match.FullyQualifiedName || match.Name, accountType: match.AccountType };
    }

    if (parentInfo.accountType && current.AccountType && parentInfo.accountType !== current.AccountType) {
      throw new Error(
        `Cannot move account to parent "${parentInfo.name}" because parent AccountType "${parentInfo.accountType}" does not match this account's AccountType "${current.AccountType}". QBO rejects sub-accounts with different AccountType than their parent.`
      );
    }

    update.SubAccount = true;
    update.ParentRef = { value: parentInfo.id };
  }

  if (draft) {
    const changes: string[] = [];
    if (name !== undefined && name !== current.Name) changes.push(`Name: "${current.Name}" -> "${name}"`);
    if (description !== undefined && description !== current.Description) changes.push(`Description: "${current.Description ?? ''}" -> "${description}"`);
    if (acct_num !== undefined && acct_num !== current.AcctNum) changes.push(`Account #: "${current.AcctNum ?? ''}" -> "${acct_num}"`);
    if (active !== undefined && active !== current.Active) changes.push(`Active: ${current.Active !== false} -> ${active}`);
    if (clear_parent) changes.push(`Parent: "${current.ParentRef?.name ?? ''}" -> (none, promoted to top-level)`);
    else if (parentInfo) changes.push(`Parent: "${current.ParentRef?.name ?? '(none)'}" -> "${parentInfo.name}"`);

    const preview = [
      "DRAFT - Account Edit Preview",
      "",
      `ID: ${current.Id}`,
      `Current Name: ${current.Name}`,
      `Current Type: ${current.AccountType ?? '?'} / ${current.AccountSubType ?? ''}`,
      `Current Parent: ${current.ParentRef?.name ?? '(none)'}`,
      `Current Active: ${current.Active !== false}`,
      "",
      "Proposed Changes:",
      ...(changes.length > 0 ? changes.map((c) => `  ${c}`) : ["  (no changes)"]),
      "",
      "Set draft=false to apply these changes.",
    ].join("\n");

    return { content: [{ type: "text", text: preview }] };
  }

  const result = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).updateAccount(update, cb)
  ) as QBAccount;

  // Invalidate the account cache so subsequent name-based resolutions reflect
  // renames, activation changes, and parent changes.
  clearLookupCache();

  const qboUrl = `https://app.qbo.intuit.com/app/chartofaccounts`;

  const lines = [
    "Account Updated!",
    "",
    `ID: ${result.Id}`,
    `New SyncToken: ${result.SyncToken}`,
    `Name: ${result.Name}`,
    `Fully Qualified Name: ${result.FullyQualifiedName ?? result.Name}`,
    `Account Type: ${result.AccountType ?? '?'}`,
    `Account Sub Type: ${result.AccountSubType ?? ''}`,
    `Description: ${result.Description ?? '(none)'}`,
    `Active: ${result.Active !== false}`,
    `Parent: ${result.SubAccount && result.ParentRef ? (result.ParentRef.name ?? result.ParentRef.value) : '(none - top-level)'}`,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return outputReport("account-edit", result, lines);
}
