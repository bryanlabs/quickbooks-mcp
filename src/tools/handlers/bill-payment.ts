// Handlers for bill payment tools (create, get, edit)

import QuickBooks from "node-quickbooks";
import { promisify, resolveVendor, resolveAccount } from "../../client/index.js";
import { outputReport } from "../../utils/index.js";

interface QBBillPayment {
  Id: string;
  SyncToken: string;
  VendorRef: { value: string; name?: string };
  PayType: "Check" | "CreditCard";
  TotalAmt: number;
  TxnDate?: string;
  PrivateNote?: string;
  DocNumber?: string;
  DepartmentRef?: { value: string; name?: string };
  CurrencyRef?: { value: string; name?: string };
  CheckPayment?: {
    BankAccountRef?: { value: string; name?: string };
    PrintStatus?: string;
  };
  CreditCardPayment?: {
    CCAccountRef?: { value: string; name?: string };
  };
  Line?: Array<{
    Amount: number;
    LinkedTxn: Array<{
      TxnId: string;
      TxnType: string;
    }>;
  }>;
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

export async function handleCreateBillPayment(
  client: QuickBooks,
  args: {
    vendor_name?: string;
    vendor_id?: string;
    pay_type: "Check" | "CreditCard";
    total_amt: number;
    txn_date?: string;
    bank_account_name?: string;
    bank_account_id?: string;
    cc_account_name?: string;
    cc_account_id?: string;
    bill_ids?: string[];
    memo?: string;
    doc_number?: string;
    department_name?: string;
    department_id?: string;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    vendor_name, vendor_id, pay_type, total_amt, txn_date,
    bank_account_name, bank_account_id,
    cc_account_name, cc_account_id,
    bill_ids, memo, doc_number,
    department_name, department_id,
    draft = true,
  } = args;

  // Resolve vendor
  const vendorRef = vendor_id
    ? { value: vendor_id }
    : vendor_name
      ? await resolveVendor(client, vendor_name)
      : null;
  if (!vendorRef) throw new Error("Either vendor_name or vendor_id is required");

  const paymentObj: Record<string, unknown> = {
    VendorRef: vendorRef,
    PayType: pay_type,
    TotalAmt: total_amt,
  };

  if (txn_date) paymentObj.TxnDate = txn_date;
  if (memo) paymentObj.PrivateNote = memo;
  if (doc_number) paymentObj.DocNumber = doc_number;

  // Resolve department
  if (department_name || department_id) {
    if (department_id) {
      paymentObj.DepartmentRef = { value: department_id };
    } else if (department_name) {
      const { resolveDepartmentId } = await import("../../client/index.js");
      const deptId = await resolveDepartmentId(client, department_name);
      paymentObj.DepartmentRef = { value: deptId };
    }
  }

  // Set payment account based on pay type
  if (pay_type === "Check") {
    const bankRef = bank_account_id
      ? { value: bank_account_id }
      : bank_account_name
        ? await resolveAccount(client, bank_account_name)
        : null;
    if (!bankRef) throw new Error("Check payments require bank_account_name or bank_account_id");
    paymentObj.CheckPayment = { BankAccountRef: bankRef };
  } else if (pay_type === "CreditCard") {
    const ccRef = cc_account_id
      ? { value: cc_account_id }
      : cc_account_name
        ? await resolveAccount(client, cc_account_name)
        : null;
    if (!ccRef) throw new Error("CreditCard payments require cc_account_name or cc_account_id");
    paymentObj.CreditCardPayment = { CCAccountRef: ccRef };
  }

  // Link to specific bills if provided
  if (bill_ids && bill_ids.length > 0) {
    paymentObj.Line = bill_ids.map(billId => ({
      Amount: total_amt / bill_ids.length, // Split evenly by default
      LinkedTxn: [{ TxnId: billId, TxnType: "Bill" }],
    }));
  }

  if (draft) {
    const vendorDisplay = (vendorRef as { name?: string }).name || vendor_name || vendor_id;
    const preview = [
      "DRAFT - Bill Payment Preview",
      "",
      `Vendor: ${vendorDisplay}`,
      `Pay Type: ${pay_type}`,
      `Amount: $${total_amt.toFixed(2)}`,
      ...(txn_date ? [`Date: ${txn_date}`] : []),
      ...(pay_type === "Check" ? [`Bank Account: ${bank_account_name || bank_account_id}`] : []),
      ...(pay_type === "CreditCard" ? [`CC Account: ${cc_account_name || cc_account_id}`] : []),
      ...(bill_ids ? [`Linked Bills: ${bill_ids.join(', ')}`] : []),
      ...(memo ? [`Memo: ${memo}`] : []),
      ...(doc_number ? [`Ref #: ${doc_number}`] : []),
      "",
      "Set draft=false to record this bill payment.",
    ].join("\n");

    return { content: [{ type: "text", text: preview }] };
  }

  const result = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).createBillPayment(paymentObj, cb)
  ) as QBBillPayment;

  const qboUrl = `https://app.qbo.intuit.com/app/billpayment?txnId=${result.Id}`;

  const response = [
    "Bill Payment Created!",
    "",
    `ID: ${result.Id}`,
    `Vendor: ${result.VendorRef?.name || "(unknown)"}`,
    `Amount: $${result.TotalAmt.toFixed(2)}`,
    `Pay Type: ${result.PayType}`,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return { content: [{ type: "text", text: response }] };
}

export async function handleGetBillPayment(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const payment = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).getBillPayment(id, cb)
  ) as QBBillPayment;

  const qboUrl = `https://app.qbo.intuit.com/app/billpayment?txnId=${payment.Id}`;

  const lines: string[] = [
    "Bill Payment",
    "============",
    `ID: ${payment.Id}`,
    `SyncToken: ${payment.SyncToken}`,
    `Vendor: ${payment.VendorRef?.name || payment.VendorRef?.value}`,
    `Pay Type: ${payment.PayType}`,
    `Amount: $${payment.TotalAmt.toFixed(2)}`,
    ...(payment.TxnDate ? [`Date: ${payment.TxnDate}`] : []),
    ...(payment.DocNumber ? [`Ref #: ${payment.DocNumber}`] : []),
    ...(payment.PrivateNote ? [`Memo: ${payment.PrivateNote}`] : []),
  ];

  if (payment.PayType === "Check" && payment.CheckPayment?.BankAccountRef) {
    lines.push(`Bank Account: ${payment.CheckPayment.BankAccountRef.name || payment.CheckPayment.BankAccountRef.value}`);
  }
  if (payment.PayType === "CreditCard" && payment.CreditCardPayment?.CCAccountRef) {
    lines.push(`CC Account: ${payment.CreditCardPayment.CCAccountRef.name || payment.CreditCardPayment.CCAccountRef.value}`);
  }

  if (payment.Line && payment.Line.length > 0) {
    lines.push("");
    lines.push("Linked Bills:");
    for (const line of payment.Line) {
      const txnIds = line.LinkedTxn?.map(t => `${t.TxnType} #${t.TxnId}`).join(', ') || "(none)";
      lines.push(`  $${line.Amount.toFixed(2)} - ${txnIds}`);
    }
  }

  if (payment.DepartmentRef) {
    lines.push(`Department: ${payment.DepartmentRef.name || payment.DepartmentRef.value}`);
  }

  lines.push("");
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`billpayment-${payment.Id}`, payment, lines.join("\n"));
}

export async function handleEditBillPayment(
  client: QuickBooks,
  args: {
    id: string;
    txn_date?: string;
    memo?: string;
    doc_number?: string;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id, txn_date, memo, doc_number, draft = true } = args;

  // Fetch current bill payment
  const current = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).getBillPayment(id, cb)
  ) as QBBillPayment;

  // BillPayment updates require the full object (VendorRef, PayType, TotalAmt, Line are required)
  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    VendorRef: current.VendorRef,
    PayType: current.PayType,
    TotalAmt: current.TotalAmt,
    sparse: true,
  };

  if (txn_date !== undefined) updated.TxnDate = txn_date;
  if (memo !== undefined) updated.PrivateNote = memo;
  if (doc_number !== undefined) updated.DocNumber = doc_number;

  const qboUrl = `https://app.qbo.intuit.com/app/billpayment?txnId=${id}`;

  if (draft) {
    const previewLines: string[] = [
      "DRAFT - Bill Payment Edit Preview",
      "",
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      `Vendor: ${current.VendorRef?.name || current.VendorRef?.value}`,
      "",
      "Changes:",
    ];

    if (txn_date !== undefined) previewLines.push(`  Date: ${current.TxnDate || "(none)"} → ${txn_date}`);
    if (memo !== undefined) previewLines.push(`  Memo: ${current.PrivateNote || "(none)"} → ${memo}`);
    if (doc_number !== undefined) previewLines.push(`  Ref #: ${current.DocNumber || "(none)"} → ${doc_number}`);

    previewLines.push("");
    previewLines.push("Set draft=false to apply these changes.");

    return { content: [{ type: "text", text: previewLines.join("\n") }] };
  }

  const result = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).updateBillPayment(updated, cb)
  ) as QBBillPayment;

  return {
    content: [{
      type: "text",
      text: `Bill Payment ${id} updated successfully.\nNew SyncToken: ${result.SyncToken}\nView in QuickBooks: ${qboUrl}`,
    }],
  };
}
