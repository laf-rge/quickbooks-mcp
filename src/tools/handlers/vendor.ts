// Handlers for vendor tools (create, edit). Reads go through the `query` tool.

import QuickBooks from "node-quickbooks";
import { promisify, promisifyWrite } from "../../client/index.js";
import { buildQboUrl, formatUpdateResult } from "../../utils/index.js";

interface AddressInput {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
}

interface QBAddress {
  Id?: string;
  Line1?: string;
  Line2?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  [key: string]: unknown;
}

interface QBVendor {
  Id: string;
  SyncToken: string;
  DisplayName: string;
  CompanyName?: string;
  Title?: string;
  GivenName?: string;
  FamilyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  BillAddr?: QBAddress;
  TermRef?: { value: string; name?: string };
  AcctNum?: string;
  Vendor1099?: boolean;
  Active?: boolean;
}

export type VendorFields = {
  display_name?: string;
  company_name?: string;
  title?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  phone?: string;
  bill_address?: AddressInput;
  term_ref?: string;
  account_number?: string;
  vendor_1099?: boolean;
};

// Type aliases, not interfaces: the dispatcher casts from Record<string, unknown>.
export type CreateVendorArgs = VendorFields & { display_name: string; draft?: boolean };
export type EditVendorArgs = VendorFields & { id: string; active?: boolean; draft?: boolean };

type ToolResult = { content: Array<{ type: string; text: string }> };

function toQBAddress(input: AddressInput): QBAddress {
  const addr: QBAddress = {};
  if (input.line1 !== undefined) addr.Line1 = input.line1;
  if (input.line2 !== undefined) addr.Line2 = input.line2;
  if (input.city !== undefined) addr.City = input.city;
  if (input.state !== undefined) addr.CountrySubDivisionCode = input.state;
  if (input.postal_code !== undefined) addr.PostalCode = input.postal_code;
  return addr;
}

function formatAddress(addr: QBAddress | undefined): string {
  if (!addr) return "(none)";
  const cityState = [addr.City, addr.CountrySubDivisionCode].filter(Boolean).join(", ");
  const parts = [addr.Line1, addr.Line2, [cityState, addr.PostalCode].filter(Boolean).join(" ")]
    .filter(Boolean);
  return parts.length ? parts.join(", ") : "(none)";
}

/** Resolve a payment term by name (case-insensitive) or Id. */
async function resolveTerm(client: QuickBooks, ref: string): Promise<{ value: string; name: string }> {
  const terms = await promisify<{ QueryResponse: { Term?: Array<{ Id: string; Name: string }> } }>((cb) =>
    (client as unknown as Record<string, Function>).findTerms(cb)
  );
  const termList = terms.QueryResponse?.Term || [];
  const match = termList.find(t => t.Name.toLowerCase() === ref.toLowerCase() || t.Id === ref);
  if (!match) {
    const available = termList.map(t => t.Name).join(", ");
    throw new Error(`Term not found: "${ref}". Available: ${available}`);
  }
  return { value: match.Id, name: match.Name };
}

/**
 * Map tool fields onto Vendor properties. Only fields that were passed are
 * set, so the same object serves a create and a sparse update. The address is
 * merged over `currentAddr` (the stored BillAddr on an edit), so changing the
 * postal code alone does not blank the street.
 */
async function buildVendorFields(
  client: QuickBooks,
  f: VendorFields,
  currentAddr?: QBAddress
): Promise<Record<string, unknown>> {
  const v: Record<string, unknown> = {};
  if (f.display_name !== undefined) v.DisplayName = f.display_name;
  if (f.company_name !== undefined) v.CompanyName = f.company_name;
  if (f.title !== undefined) v.Title = f.title;
  if (f.given_name !== undefined) v.GivenName = f.given_name;
  if (f.family_name !== undefined) v.FamilyName = f.family_name;
  if (f.email !== undefined) v.PrimaryEmailAddr = { Address: f.email };
  if (f.phone !== undefined) v.PrimaryPhone = { FreeFormNumber: f.phone };
  if (f.bill_address !== undefined) v.BillAddr = { ...(currentAddr ?? {}), ...toQBAddress(f.bill_address) };
  if (f.term_ref !== undefined) v.TermRef = await resolveTerm(client, f.term_ref);
  if (f.account_number !== undefined) v.AcctNum = f.account_number;
  if (f.vendor_1099 !== undefined) v.Vendor1099 = f.vendor_1099;
  return v;
}

/**
 * One "Label: value" line per property present on `v`. A property that is
 * present but null/empty (the stored value on an edit preview) shows "(none)".
 */
function describe(v: Record<string, unknown>): string[] {
  const q = v as Partial<QBVendor>;
  const show = (x: string | undefined | null) => (x === undefined || x === null || x === "" ? "(none)" : x);
  const rows: Array<[string, string, () => string]> = [
    ["DisplayName", "Display Name", () => show(q.DisplayName)],
    ["CompanyName", "Company", () => show(q.CompanyName)],
    ["Title", "Title", () => show(q.Title)],
    ["GivenName", "Given Name", () => show(q.GivenName)],
    ["FamilyName", "Family Name", () => show(q.FamilyName)],
    ["PrimaryEmailAddr", "Email", () => show(q.PrimaryEmailAddr?.Address)],
    ["PrimaryPhone", "Phone", () => show(q.PrimaryPhone?.FreeFormNumber)],
    ["BillAddr", "Billing Address", () => formatAddress(q.BillAddr ?? undefined)],
    ["TermRef", "Terms", () => show(q.TermRef?.name ?? q.TermRef?.value)],
    ["AcctNum", "Account Number", () => show(q.AcctNum)],
    ["Vendor1099", "1099 Vendor", () => String(q.Vendor1099 ?? false)],
    ["Active", "Active", () => String(q.Active ?? true)],
  ];
  return rows.filter(([key]) => key in v).map(([, label, fmt]) => `${label}: ${fmt()}`);
}

export async function handleCreateVendor(
  client: QuickBooks,
  args: CreateVendorArgs
): Promise<ToolResult> {
  const { draft = true, ...fields } = args;
  const vendorObj = await buildVendorFields(client, fields);

  if (draft) {
    const preview = [
      "DRAFT - Vendor Preview",
      "",
      ...describe(vendorObj),
      "",
      "Set draft=false to create this vendor.",
    ].join("\n");
    return { content: [{ type: "text", text: preview }] };
  }

  const result = await promisifyWrite<unknown>((cb) =>
    client.createVendor(vendorObj, cb)
  ) as QBVendor;

  const text = [
    "Vendor Created!",
    "",
    `ID: ${result.Id}`,
    `Display Name: ${result.DisplayName}`,
    "",
    `View in QuickBooks: ${buildQboUrl("vendordetail", "nameId", result.Id)}`,
  ].join("\n");
  return { content: [{ type: "text", text }] };
}

export async function handleEditVendor(
  client: QuickBooks,
  args: EditVendorArgs
): Promise<ToolResult> {
  const { id, active, draft = true, ...fields } = args;

  // Fetch fresh so the SyncToken is current and the address merge sees the
  // stored value.
  const current = await promisify<unknown>((cb) => client.getVendor(id, cb)) as QBVendor;

  const changes = await buildVendorFields(client, fields, current.BillAddr);
  if (active !== undefined) changes.Active = active;

  // Sparse: QuickBooks leaves every property not in the payload untouched.
  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    sparse: true,
    ...changes,
  };

  const qboUrl = buildQboUrl("vendordetail", "nameId", current.Id);

  if (draft) {
    const stored = current as unknown as Record<string, unknown>;
    const before = describe(Object.fromEntries(Object.keys(changes).map((k) => [k, stored[k] ?? null])));
    const after = describe(changes);
    const preview = [
      "DRAFT - Vendor Edit Preview",
      "",
      `ID: ${current.Id} (${current.DisplayName})`,
      `SyncToken: ${current.SyncToken}`,
      "",
      "Before:",
      ...before.map((l) => `  ${l}`),
      "After:",
      ...after.map((l) => `  ${l}`),
      "",
      "Fields not listed are left unchanged. Set draft=false to apply.",
    ].join("\n");
    return { content: [{ type: "text", text: preview }] };
  }

  const result = await promisifyWrite<unknown>((cb) =>
    client.updateVendor(updated, cb)
  ) as QBVendor;

  return {
    content: [{
      type: "text",
      text: formatUpdateResult("Vendor", current.Id, current.SyncToken, result.SyncToken, qboUrl),
    }],
  };
}
