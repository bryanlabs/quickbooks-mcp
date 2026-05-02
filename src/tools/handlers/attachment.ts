// Handler for create_attachment tool
//
// Uploads a file to QuickBooks as an Attachable and links it to an existing entity
// (Bill, Invoice, Purchase/Expense, JournalEntry, Customer, Vendor, etc.).
// Wraps node-quickbooks's `upload()` method, which posts the file to /upload and
// then issues an updateAttachable call to set AttachableRef.

import { createReadStream, statSync } from "node:fs";
import { basename, extname } from "node:path";
import QuickBooks from "node-quickbooks";
import { promisify } from "../../client/index.js";
import { outputReport } from "../../utils/index.js";

interface QBAttachable {
  Id: string;
  SyncToken: string;
  FileName: string;
  ContentType: string;
  Size: number;
  documentId?: string;
  FileAccessUri?: string;
  AttachableRef?: Array<{
    EntityRef: { value: string; type: string };
    IncludeOnSend?: boolean;
  }>;
}

// Map common file extensions to MIME types. QBO accepts most standard types;
// see https://developer.intuit.com/app/developer/qbo/docs/api/accounting/most-commonly-used/attachable
const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".html": "text/html",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function inferContentType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

// Entity types accepted by QBO Attachable links. The list mirrors the entities
// that have a CreateTime/SyncToken and are commonly attached to in the UI.
const VALID_ENTITY_TYPES = new Set([
  "Bill",
  "Invoice",
  "Estimate",
  "Purchase",
  "PurchaseOrder",
  "JournalEntry",
  "Payment",
  "BillPayment",
  "VendorCredit",
  "CreditMemo",
  "RefundReceipt",
  "SalesReceipt",
  "Deposit",
  "Customer",
  "Vendor",
  "Employee",
  "Item",
  "Transfer",
  "TimeActivity",
]);

export async function handleCreateAttachment(
  client: QuickBooks,
  args: {
    file_path: string;
    entity_type: string;
    entity_id: string;
    file_name?: string;
    content_type?: string;
    note?: string;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    file_path,
    entity_type,
    entity_id,
    file_name,
    content_type,
    note,
    draft = true,
  } = args;

  if (!file_path) throw new Error("file_path is required");
  if (!entity_type) throw new Error("entity_type is required (e.g., 'Bill', 'Invoice', 'Purchase')");
  if (!entity_id) throw new Error("entity_id is required");

  if (!VALID_ENTITY_TYPES.has(entity_type)) {
    const valid = [...VALID_ENTITY_TYPES].sort().join(", ");
    throw new Error(`entity_type "${entity_type}" is not a recognized QBO attachable entity. Valid: ${valid}`);
  }

  // Resolve filename and content type before any I/O so previews are honest.
  const resolvedFileName = file_name || basename(file_path);
  const resolvedContentType = content_type || inferContentType(file_path);

  // Probe the file early to surface clear errors (missing file, unreadable, etc).
  let size: number;
  try {
    size = statSync(file_path).size;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read file_path "${file_path}": ${message}`);
  }

  if (draft) {
    const preview = [
      "DRAFT - Attachment Preview",
      "",
      `Source file: ${file_path}`,
      `Filename in QBO: ${resolvedFileName}`,
      `Content type: ${resolvedContentType}`,
      `Size: ${size} bytes`,
      `Link to: ${entity_type} (id ${entity_id})`,
      ...(note ? [`Note: ${note}`] : []),
      "",
      "Set draft=false to upload and link this attachment.",
    ].join("\n");

    return { content: [{ type: "text", text: preview }] };
  }

  const stream = createReadStream(file_path);

  const result = await promisify<unknown>((cb) =>
    (client as unknown as Record<string, Function>).upload(
      resolvedFileName,
      resolvedContentType,
      stream,
      entity_type,
      entity_id,
      cb
    )
  ) as QBAttachable;

  // QBO returns an AttachableResponse[]; node-quickbooks unwraps to the inner Attachable.
  // Defensive: ensure we have an Id before celebrating.
  if (!result || !result.Id) {
    throw new Error(`Upload returned no Attachable Id. Raw: ${JSON.stringify(result)}`);
  }

  const linkedRef = result.AttachableRef?.[0]?.EntityRef;
  const lines = [
    "Attachment Uploaded!",
    "",
    `Attachable Id: ${result.Id}`,
    `Filename: ${result.FileName}`,
    `Content type: ${result.ContentType}`,
    `Size: ${result.Size} bytes`,
    `Linked to: ${linkedRef ? `${linkedRef.type} ${linkedRef.value}` : "(no link returned)"}`,
    ...(result.documentId ? [`Document Id: ${result.documentId}`] : []),
  ].join("\n");

  return outputReport("attachment-create", result, lines);
}
