// Handlers for vendor tools (create, get, edit)

import QuickBooks from "node-quickbooks";
import { promisify } from "../../client/index.js";
import { outputReport } from "../../utils/index.js";

interface AddressInput {
  line1?: string;
  line2?: string;
  line3?: string;
  city?: string;
  country_sub_division_code?: string;
  postal_code?: string;
  country?: string;
}

interface QBAddress {
  Line1?: string;
  Line2?: string;
  Line3?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
}

function buildQBAddress(input: AddressInput): QBAddress {
  const addr: QBAddress = {};
  if (input.line1) addr.Line1 = input.line1;
  if (input.line2) addr.Line2 = input.line2;
  if (input.line3) addr.Line3 = input.line3;
  if (input.city) addr.City = input.city;
  if (input.country_sub_division_code) addr.CountrySubDivisionCode = input.country_sub_division_code;
  if (input.postal_code) addr.PostalCode = input.postal_code;
  if (input.country) addr.Country = input.country;
  return addr;
}

function formatAddress(addr: QBAddress | undefined, label: string): string[] {
  if (!addr) return [`${label}: (none)`];
  const parts: string[] = [];
  for (const key of ['Line1', 'Line2', 'Line3'] as const) {
    if (addr[key]) parts.push(addr[key]!);
  }
  if (addr.City || addr.CountrySubDivisionCode || addr.PostalCode) {
    const cityState = [addr.City, addr.CountrySubDivisionCode].filter(Boolean).join(', ');
    parts.push([cityState, addr.PostalCode].filter(Boolean).join(' '));
  }
  if (addr.Country) parts.push(addr.Country);
  if (parts.length === 0) return [`${label}: (none)`];
  return [`${label}:`, ...parts.map(p => `  ${p}`)];
}

interface QBVendor {
  Id: string;
  SyncToken: string;
  DisplayName: string;
  GivenName?: string;
  MiddleName?: string;
  FamilyName?: string;
  Suffix?: string;
  Title?: string;
  CompanyName?: string;
  PrintOnCheckName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  Mobile?: { FreeFormNumber?: string };
  Fax?: { FreeFormNumber?: string };
  WebAddr?: { URI?: string };
  BillAddr?: QBAddress;
  AcctNum?: string;
  Vendor1099?: boolean;
  TaxIdentifier?: string;
  TermRef?: { value: string; name?: string };
  Balance?: number;
  Active?: boolean;
  BillRate?: number;
  CurrencyRef?: { value: string; name?: string };
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

export async function handleCreateVendor(
  client: QuickBooks,
  args: {
    display_name: string;
    given_name?: string;
    middle_name?: string;
    family_name?: string;
    suffix?: string;
    title?: string;
    company_name?: string;
    print_on_check_name?: string;
    email?: string;
    phone?: string;
    mobile?: string;
    fax?: string;
    website?: string;
    bill_address?: AddressInput;
    acct_num?: string;
    vendor_1099?: boolean;
    tax_identifier?: string;
    term_ref?: string;
    bill_rate?: number;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    display_name, given_name, middle_name, family_name, suffix, title,
    company_name, print_on_check_name, email, phone, mobile, fax, website,
    bill_address, acct_num, vendor_1099, tax_identifier, term_ref, bill_rate,
    draft = true,
  } = args;

  const vendorObj: Record<string, unknown> = {
    DisplayName: display_name,
  };
  if (given_name) vendorObj.GivenName = given_name;
  if (middle_name) vendorObj.MiddleName = middle_name;
  if (family_name) vendorObj.FamilyName = family_name;
  if (suffix) vendorObj.Suffix = suffix;
  if (title) vendorObj.Title = title;
  if (company_name) vendorObj.CompanyName = company_name;
  if (print_on_check_name) vendorObj.PrintOnCheckName = print_on_check_name;
  if (email) vendorObj.PrimaryEmailAddr = { Address: email };
  if (phone) vendorObj.PrimaryPhone = { FreeFormNumber: phone };
  if (mobile) vendorObj.Mobile = { FreeFormNumber: mobile };
  if (fax) vendorObj.Fax = { FreeFormNumber: fax };
  if (website) vendorObj.WebAddr = { URI: website };
  if (bill_address) vendorObj.BillAddr = buildQBAddress(bill_address);
  if (acct_num) vendorObj.AcctNum = acct_num;
  if (vendor_1099 !== undefined) vendorObj.Vendor1099 = vendor_1099;
  if (tax_identifier) vendorObj.TaxIdentifier = tax_identifier;
  if (bill_rate !== undefined) vendorObj.BillRate = bill_rate;

  // Resolve payment terms
  let termName: string | undefined;
  if (term_ref) {
    const terms = await promisify<{ QueryResponse: { Term?: Array<{ Id: string; Name: string }> } }>((cb) =>
      (client as unknown as Record<string, Function>).findTerms(cb)
    );
    const termList = terms.QueryResponse?.Term || [];
    const match = termList.find(t =>
      t.Name.toLowerCase() === term_ref.toLowerCase() ||
      t.Id === term_ref
    );
    if (!match) {
      const available = termList.map(t => t.Name).join(', ');
      throw new Error(`Term not found: "${term_ref}". Available: ${available}`);
    }
    vendorObj.TermRef = { value: match.Id, name: match.Name };
    termName = match.Name;
  }

  if (draft) {
    const preview = [
      "DRAFT - Vendor Preview",
      "",
      `Display Name: ${display_name}`,
      ...(given_name || middle_name || family_name || suffix || title
        ? [`Name Parts: ${[title, given_name, middle_name, family_name, suffix].filter(Boolean).join(' ')}`]
        : []),
      `Company: ${company_name || "(none)"}`,
      `Print on Check: ${print_on_check_name || "(default)"}`,
      `Email: ${email || "(none)"}`,
      `Phone: ${phone || "(none)"}`,
      `Mobile: ${mobile || "(none)"}`,
      `Fax: ${fax || "(none)"}`,
      `Website: ${website || "(none)"}`,
      ...formatAddress(bill_address ? buildQBAddress(bill_address) : undefined, "Address"),
      `Account #: ${acct_num || "(none)"}`,
      `1099 Vendor: ${vendor_1099 !== undefined ? vendor_1099 : "(default)"}`,
      `Tax ID: ${tax_identifier ? "(provided)" : "(none)"}`,
      ...(termName ? [`Terms: ${termName}`] : []),
      ...(bill_rate !== undefined ? [`Bill Rate: ${bill_rate}`] : []),
      "",
      "Set draft=false to create this vendor.",
    ].join("\n");

    return { content: [{ type: "text", text: preview }] };
  }

  const result = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).createVendor(vendorObj, cb)
  ) as QBVendor;

  const qboUrl = `https://app.qbo.intuit.com/app/vendordetail?nameId=${result.Id}`;

  const response = [
    "Vendor Created!",
    "",
    `ID: ${result.Id}`,
    `Display Name: ${result.DisplayName}`,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return { content: [{ type: "text", text: response }] };
}

export async function handleGetVendor(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const vendor = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).getVendor(id, cb)
  ) as QBVendor;

  const qboUrl = `https://app.qbo.intuit.com/app/vendordetail?nameId=${vendor.Id}`;

  const lines: string[] = [
    "Vendor",
    "======",
    `ID: ${vendor.Id}`,
    `SyncToken: ${vendor.SyncToken}`,
    `Display Name: ${vendor.DisplayName}`,
    `Active: ${vendor.Active !== false}`,
  ];

  if (vendor.Title || vendor.GivenName || vendor.MiddleName || vendor.FamilyName || vendor.Suffix) {
    lines.push(`Name: ${[vendor.Title, vendor.GivenName, vendor.MiddleName, vendor.FamilyName, vendor.Suffix].filter(Boolean).join(' ')}`);
  }
  if (vendor.CompanyName) lines.push(`Company: ${vendor.CompanyName}`);
  if (vendor.PrintOnCheckName) lines.push(`Print on Check: ${vendor.PrintOnCheckName}`);
  lines.push(`Email: ${vendor.PrimaryEmailAddr?.Address || "(none)"}`);
  lines.push(`Phone: ${vendor.PrimaryPhone?.FreeFormNumber || "(none)"}`);
  if (vendor.Mobile?.FreeFormNumber) lines.push(`Mobile: ${vendor.Mobile.FreeFormNumber}`);
  if (vendor.Fax?.FreeFormNumber) lines.push(`Fax: ${vendor.Fax.FreeFormNumber}`);
  if (vendor.WebAddr?.URI) lines.push(`Website: ${vendor.WebAddr.URI}`);
  lines.push(...formatAddress(vendor.BillAddr, "Address"));
  if (vendor.AcctNum) lines.push(`Account #: ${vendor.AcctNum}`);
  lines.push(`1099 Vendor: ${vendor.Vendor1099 ?? false}`);
  if (vendor.TaxIdentifier) lines.push(`Tax ID: ${vendor.TaxIdentifier}`);
  lines.push(`Terms: ${vendor.TermRef?.name || "(none)"}`);
  if (vendor.BillRate !== undefined) lines.push(`Bill Rate: ${vendor.BillRate}`);
  lines.push(`Balance: $${(vendor.Balance || 0).toFixed(2)}`);
  if (vendor.CurrencyRef) lines.push(`Currency: ${vendor.CurrencyRef.name || vendor.CurrencyRef.value}`);
  lines.push("");
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`vendor-${vendor.Id}`, vendor, lines.join("\n"));
}

export async function handleEditVendor(
  client: QuickBooks,
  args: {
    id: string;
    display_name?: string;
    given_name?: string;
    middle_name?: string;
    family_name?: string;
    suffix?: string;
    title?: string;
    company_name?: string;
    print_on_check_name?: string;
    email?: string;
    phone?: string;
    mobile?: string;
    fax?: string;
    website?: string;
    bill_address?: AddressInput;
    acct_num?: string;
    vendor_1099?: boolean;
    tax_identifier?: string;
    term_ref?: string;
    bill_rate?: number;
    active?: boolean;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    id, display_name, given_name, middle_name, family_name, suffix, title,
    company_name, print_on_check_name, email, phone, mobile, fax, website,
    bill_address, acct_num, vendor_1099, tax_identifier, term_ref, bill_rate,
    active, draft = true,
  } = args;

  // Fetch current vendor
  const current = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).getVendor(id, cb)
  ) as QBVendor;

  // Build sparse update
  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    sparse: true,
  };

  if (display_name !== undefined) updated.DisplayName = display_name;
  if (given_name !== undefined) updated.GivenName = given_name;
  if (middle_name !== undefined) updated.MiddleName = middle_name;
  if (family_name !== undefined) updated.FamilyName = family_name;
  if (suffix !== undefined) updated.Suffix = suffix;
  if (title !== undefined) updated.Title = title;
  if (company_name !== undefined) updated.CompanyName = company_name;
  if (print_on_check_name !== undefined) updated.PrintOnCheckName = print_on_check_name;
  if (email !== undefined) updated.PrimaryEmailAddr = { Address: email };
  if (phone !== undefined) updated.PrimaryPhone = { FreeFormNumber: phone };
  if (mobile !== undefined) updated.Mobile = { FreeFormNumber: mobile };
  if (fax !== undefined) updated.Fax = { FreeFormNumber: fax };
  if (website !== undefined) updated.WebAddr = { URI: website };
  if (bill_address !== undefined) updated.BillAddr = buildQBAddress(bill_address);
  if (acct_num !== undefined) updated.AcctNum = acct_num;
  if (vendor_1099 !== undefined) updated.Vendor1099 = vendor_1099;
  if (tax_identifier !== undefined) updated.TaxIdentifier = tax_identifier;
  if (bill_rate !== undefined) updated.BillRate = bill_rate;
  if (active !== undefined) updated.Active = active;

  // Resolve payment terms if provided
  if (term_ref !== undefined) {
    const terms = await promisify<{ QueryResponse: { Term?: Array<{ Id: string; Name: string }> } }>((cb) =>
      (client as unknown as Record<string, Function>).findTerms(cb)
    );
    const termList = terms.QueryResponse?.Term || [];
    const match = termList.find(t =>
      t.Name.toLowerCase() === term_ref.toLowerCase() ||
      t.Id === term_ref
    );
    if (!match) {
      const available = termList.map(t => t.Name).join(', ');
      throw new Error(`Term not found: "${term_ref}". Available: ${available}`);
    }
    updated.TermRef = { value: match.Id, name: match.Name };
  }

  const qboUrl = `https://app.qbo.intuit.com/app/vendordetail?nameId=${id}`;

  if (draft) {
    const previewLines: string[] = [
      "DRAFT - Vendor Edit Preview",
      "",
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      "",
      "Changes:",
    ];

    if (display_name !== undefined) previewLines.push(`  Display Name: ${current.DisplayName} → ${display_name}`);
    if (given_name !== undefined) previewLines.push(`  Given Name: ${current.GivenName || "(none)"} → ${given_name}`);
    if (middle_name !== undefined) previewLines.push(`  Middle Name: ${current.MiddleName || "(none)"} → ${middle_name}`);
    if (family_name !== undefined) previewLines.push(`  Family Name: ${current.FamilyName || "(none)"} → ${family_name}`);
    if (suffix !== undefined) previewLines.push(`  Suffix: ${current.Suffix || "(none)"} → ${suffix}`);
    if (title !== undefined) previewLines.push(`  Title: ${current.Title || "(none)"} → ${title}`);
    if (company_name !== undefined) previewLines.push(`  Company: ${current.CompanyName || "(none)"} → ${company_name}`);
    if (print_on_check_name !== undefined) previewLines.push(`  Print on Check: ${current.PrintOnCheckName || "(none)"} → ${print_on_check_name}`);
    if (email !== undefined) previewLines.push(`  Email: ${current.PrimaryEmailAddr?.Address || "(none)"} → ${email}`);
    if (phone !== undefined) previewLines.push(`  Phone: ${current.PrimaryPhone?.FreeFormNumber || "(none)"} → ${phone}`);
    if (mobile !== undefined) previewLines.push(`  Mobile: ${current.Mobile?.FreeFormNumber || "(none)"} → ${mobile}`);
    if (fax !== undefined) previewLines.push(`  Fax: ${current.Fax?.FreeFormNumber || "(none)"} → ${fax}`);
    if (website !== undefined) previewLines.push(`  Website: ${current.WebAddr?.URI || "(none)"} → ${website}`);
    if (bill_address !== undefined) previewLines.push("  Address: (updating)");
    if (acct_num !== undefined) previewLines.push(`  Account #: ${current.AcctNum || "(none)"} → ${acct_num}`);
    if (vendor_1099 !== undefined) previewLines.push(`  1099 Vendor: ${current.Vendor1099 ?? false} → ${vendor_1099}`);
    if (tax_identifier !== undefined) previewLines.push(`  Tax ID: (updating)`);
    if (term_ref !== undefined) {
      const newTerm = (updated.TermRef as { name?: string })?.name || term_ref;
      previewLines.push(`  Terms: ${current.TermRef?.name || '(none)'} → ${newTerm}`);
    }
    if (bill_rate !== undefined) previewLines.push(`  Bill Rate: ${current.BillRate ?? "(none)"} → ${bill_rate}`);
    if (active !== undefined) previewLines.push(`  Active: ${current.Active !== false} → ${active}`);

    previewLines.push("");
    previewLines.push("Set draft=false to apply these changes.");

    return { content: [{ type: "text", text: previewLines.join("\n") }] };
  }

  const result = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).updateVendor(updated, cb)
  ) as QBVendor;

  return {
    content: [{
      type: "text",
      text: `Vendor ${id} updated successfully.\nNew SyncToken: ${result.SyncToken}\nView in QuickBooks: ${qboUrl}`,
    }],
  };
}
