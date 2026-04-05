// Handlers for employee tools (get, edit)
// Note: Employee creation is typically done through QBO Payroll, not the API.
// We support get and edit for viewing/updating employee records.

import QuickBooks from "node-quickbooks";
import { promisify } from "../../client/index.js";
import { outputReport } from "../../utils/index.js";

interface QBAddress {
  Line1?: string;
  Line2?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
}

interface QBEmployee {
  Id: string;
  SyncToken: string;
  DisplayName: string;
  GivenName?: string;
  MiddleName?: string;
  FamilyName?: string;
  Suffix?: string;
  Title?: string;
  PrintOnCheckName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  Mobile?: { FreeFormNumber?: string };
  PrimaryAddr?: QBAddress;
  SSN?: string;
  BirthDate?: string;
  Gender?: string;
  HiredDate?: string;
  ReleasedDate?: string;
  EmployeeNumber?: string;
  BillableTime?: boolean;
  Active?: boolean;
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

function formatAddress(addr: QBAddress | undefined, label: string): string[] {
  if (!addr) return [`${label}: (none)`];
  const parts: string[] = [];
  if (addr.Line1) parts.push(addr.Line1);
  if (addr.Line2) parts.push(addr.Line2);
  if (addr.City || addr.CountrySubDivisionCode || addr.PostalCode) {
    const cityState = [addr.City, addr.CountrySubDivisionCode].filter(Boolean).join(', ');
    parts.push([cityState, addr.PostalCode].filter(Boolean).join(' '));
  }
  if (parts.length === 0) return [`${label}: (none)`];
  return [`${label}:`, ...parts.map(p => `  ${p}`)];
}

export async function handleGetEmployee(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const employee = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).getEmployee(id, cb)
  ) as QBEmployee;

  const qboUrl = `https://app.qbo.intuit.com/app/employeedetail?nameId=${employee.Id}`;

  const lines: string[] = [
    "Employee",
    "========",
    `ID: ${employee.Id}`,
    `SyncToken: ${employee.SyncToken}`,
    `Display Name: ${employee.DisplayName}`,
    `Active: ${employee.Active !== false}`,
  ];

  if (employee.Title || employee.GivenName || employee.MiddleName || employee.FamilyName || employee.Suffix) {
    lines.push(`Name: ${[employee.Title, employee.GivenName, employee.MiddleName, employee.FamilyName, employee.Suffix].filter(Boolean).join(' ')}`);
  }
  if (employee.PrintOnCheckName) lines.push(`Print on Check: ${employee.PrintOnCheckName}`);
  lines.push(`Email: ${employee.PrimaryEmailAddr?.Address || "(none)"}`);
  lines.push(`Phone: ${employee.PrimaryPhone?.FreeFormNumber || "(none)"}`);
  if (employee.Mobile?.FreeFormNumber) lines.push(`Mobile: ${employee.Mobile.FreeFormNumber}`);
  lines.push(...formatAddress(employee.PrimaryAddr, "Address"));
  if (employee.SSN) lines.push(`SSN: ${employee.SSN}`);
  if (employee.EmployeeNumber) lines.push(`Employee #: ${employee.EmployeeNumber}`);
  if (employee.HiredDate) lines.push(`Hired: ${employee.HiredDate}`);
  if (employee.ReleasedDate) lines.push(`Released: ${employee.ReleasedDate}`);
  if (employee.BirthDate) lines.push(`Birth Date: ${employee.BirthDate}`);
  if (employee.Gender) lines.push(`Gender: ${employee.Gender}`);
  if (employee.BillableTime !== undefined) lines.push(`Billable Time: ${employee.BillableTime}`);
  lines.push("");
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`employee-${employee.Id}`, employee, lines.join("\n"));
}

export async function handleEditEmployee(
  client: QuickBooks,
  args: {
    id: string;
    display_name?: string;
    given_name?: string;
    family_name?: string;
    email?: string;
    phone?: string;
    mobile?: string;
    print_on_check_name?: string;
    employee_number?: string;
    billable_time?: boolean;
    active?: boolean;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    id, display_name, given_name, family_name, email, phone, mobile,
    print_on_check_name, employee_number, billable_time, active,
    draft = true,
  } = args;

  const current = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).getEmployee(id, cb)
  ) as QBEmployee;

  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    sparse: true,
  };

  if (display_name !== undefined) updated.DisplayName = display_name;
  if (given_name !== undefined) updated.GivenName = given_name;
  if (family_name !== undefined) updated.FamilyName = family_name;
  if (email !== undefined) updated.PrimaryEmailAddr = { Address: email };
  if (phone !== undefined) updated.PrimaryPhone = { FreeFormNumber: phone };
  if (mobile !== undefined) updated.Mobile = { FreeFormNumber: mobile };
  if (print_on_check_name !== undefined) updated.PrintOnCheckName = print_on_check_name;
  if (employee_number !== undefined) updated.EmployeeNumber = employee_number;
  if (billable_time !== undefined) updated.BillableTime = billable_time;
  if (active !== undefined) updated.Active = active;

  const qboUrl = `https://app.qbo.intuit.com/app/employeedetail?nameId=${id}`;

  if (draft) {
    const previewLines: string[] = [
      "DRAFT - Employee Edit Preview",
      "",
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      "",
      "Changes:",
    ];

    if (display_name !== undefined) previewLines.push(`  Display Name: ${current.DisplayName} → ${display_name}`);
    if (given_name !== undefined) previewLines.push(`  Given Name: ${current.GivenName || "(none)"} → ${given_name}`);
    if (family_name !== undefined) previewLines.push(`  Family Name: ${current.FamilyName || "(none)"} → ${family_name}`);
    if (email !== undefined) previewLines.push(`  Email: ${current.PrimaryEmailAddr?.Address || "(none)"} → ${email}`);
    if (phone !== undefined) previewLines.push(`  Phone: ${current.PrimaryPhone?.FreeFormNumber || "(none)"} → ${phone}`);
    if (mobile !== undefined) previewLines.push(`  Mobile: ${current.Mobile?.FreeFormNumber || "(none)"} → ${mobile}`);
    if (print_on_check_name !== undefined) previewLines.push(`  Print on Check: ${current.PrintOnCheckName || "(none)"} → ${print_on_check_name}`);
    if (employee_number !== undefined) previewLines.push(`  Employee #: ${current.EmployeeNumber || "(none)"} → ${employee_number}`);
    if (billable_time !== undefined) previewLines.push(`  Billable Time: ${current.BillableTime ?? "(default)"} → ${billable_time}`);
    if (active !== undefined) previewLines.push(`  Active: ${current.Active !== false} → ${active}`);

    previewLines.push("");
    previewLines.push("Set draft=false to apply these changes.");

    return { content: [{ type: "text", text: previewLines.join("\n") }] };
  }

  const result = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).updateEmployee(updated, cb)
  ) as QBEmployee;

  return {
    content: [{
      type: "text",
      text: `Employee ${id} updated successfully.\nNew SyncToken: ${result.SyncToken}\nView in QuickBooks: ${qboUrl}`,
    }],
  };
}
