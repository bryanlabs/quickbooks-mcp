import axios from "axios";
import QuickBooks from "node-quickbooks";

interface RawQueryClient {
  token: string;
  realmId: string;
  endpoint: string;
  minorversion: number;
}

interface RawQueryResponse<T> {
  QueryResponse: Record<string, T[] | number | string | undefined>;
  time?: string;
}

export async function rawQuery<T = Record<string, unknown>>(
  client: QuickBooks,
  sql: string
): Promise<{ entityKey: string; entities: T[] }> {
  const c = client as unknown as RawQueryClient;
  const url = `${c.endpoint}${c.realmId}/query?query=${encodeURIComponent(sql)}&minorversion=${c.minorversion}`;

  const res = await axios.get<RawQueryResponse<T>>(url, {
    headers: {
      Authorization: `Bearer ${c.token}`,
      Accept: "application/json",
      "User-Agent": "quickbooks-mcp",
    },
  });

  const qr = res.data?.QueryResponse ?? {};
  const entityKey = Object.keys(qr).find(k => Array.isArray(qr[k])) ?? "Unknown";
  const entities = (qr[entityKey] as T[] | undefined) ?? [];
  return { entityKey, entities };
}

export async function rawPaginatedQuery<T = Record<string, unknown>>(
  client: QuickBooks,
  entity: string,
  whereClause?: string,
  maxResults = 1000
): Promise<T[]> {
  const all: T[] = [];
  let start = 1;
  const batch = 1000;

  while (all.length < maxResults) {
    const limit = Math.min(batch, maxResults - all.length);
    const where = whereClause ? `${whereClause} ` : "";
    const sql = `SELECT * FROM ${entity} ${where}STARTPOSITION ${start} MAXRESULTS ${limit}`.replace(/\s+/g, " ").trim();
    const { entities } = await rawQuery<T>(client, sql);
    if (entities.length === 0) break;
    all.push(...entities);
    if (entities.length < limit) break;
    start += entities.length;
  }

  return all;
}
