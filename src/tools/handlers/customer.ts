// Handlers for customer tools (create, get, edit)

import QuickBooks from "node-quickbooks";
import { promisify, promisifyWrite, resolveCustomer } from "../../client/index.js";
import { buildQboUrl, outputReport, formatUpdateResult } from "../../utils/index.js";

interface AddressInput {
  line1?: string;
  line2?: string;
  line3?: string;
  line4?: string;
  line5?: string;
  city?: string;
  country_sub_division_code?: string;
  postal_code?: string;
  country?: string;
  lat?: string;
  long?: string;
}

interface QBAddress {
  Line1?: string;
  Line2?: string;
  Line3?: string;
  Line4?: string;
  Line5?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
  Lat?: string;
  Long?: string;
}

function buildQBAddress(input: AddressInput): QBAddress {
  const addr: QBAddress = {};
  if (input.line1) addr.Line1 = input.line1;
  if (input.line2) addr.Line2 = input.line2;
  if (input.line3) addr.Line3 = input.line3;
  if (input.line4) addr.Line4 = input.line4;
  if (input.line5) addr.Line5 = input.line5;
  if (input.city) addr.City = input.city;
  if (input.country_sub_division_code) addr.CountrySubDivisionCode = input.country_sub_division_code;
  if (input.postal_code) addr.PostalCode = input.postal_code;
  if (input.country) addr.Country = input.country;
  if (input.lat) addr.Lat = input.lat;
  if (input.long) addr.Long = input.long;
  return addr;
}

function formatAddress(addr: QBAddress | undefined, label: string): string[] {
  if (!addr) return [`${label}: (none)`];
  const parts: string[] = [];
  for (const key of ['Line1', 'Line2', 'Line3', 'Line4', 'Line5'] as const) {
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

// QB Customer object shape (relevant fields)
interface QBCustomer {
  Id: string;
  SyncToken: string;
  DisplayName: string;
  GivenName?: string;
  MiddleName?: string;
  FamilyName?: string;
  Suffix?: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  Mobile?: { FreeFormNumber?: string };
  BillAddr?: QBAddress;
  ShipAddr?: QBAddress;
  Notes?: string;
  Taxable?: boolean;
  Active?: boolean;
  Balance?: number;
  BalanceWithJobs?: number;
  FullyQualifiedName?: string;
  Job?: boolean;
  BillWithParent?: boolean;
  ParentRef?: { value: string; name?: string };
  PreferredDeliveryMethod?: string;
  SalesTermRef?: { value: string; name?: string };
  MetaData?: { CreateTime?: string; LastUpdatedTime?: string };
}

export async function handleCreateCustomer(
  client: QuickBooks,
  args: {
    display_name: string;
    given_name?: string;
    middle_name?: string;
    family_name?: string;
    suffix?: string;
    company_name?: string;
    email?: string;
    phone?: string;
    mobile?: string;
    bill_address?: AddressInput;
    ship_address?: AddressInput;
    notes?: string;
    taxable?: boolean;
    parent_ref?: string;
    job?: boolean;
    bill_with_parent?: boolean;
    preferred_delivery_method?: string;
    sales_term_ref?: string;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    display_name, given_name, middle_name, family_name, suffix,
    company_name, email, phone, mobile,
    bill_address, ship_address, notes, taxable,
    parent_ref, job, bill_with_parent, preferred_delivery_method, sales_term_ref,
    draft = true,
  } = args;

  // Build QB Customer object
  const customerObj: Record<string, unknown> = {
    DisplayName: display_name,
  };
  if (given_name) customerObj.GivenName = given_name;
  if (middle_name) customerObj.MiddleName = middle_name;
  if (family_name) customerObj.FamilyName = family_name;
  if (suffix) customerObj.Suffix = suffix;
  if (company_name) customerObj.CompanyName = company_name;
  if (email) customerObj.PrimaryEmailAddr = { Address: email };
  if (phone) customerObj.PrimaryPhone = { FreeFormNumber: phone };
  if (mobile) customerObj.Mobile = { FreeFormNumber: mobile };
  if (bill_address) customerObj.BillAddr = buildQBAddress(bill_address);
  if (ship_address) customerObj.ShipAddr = buildQBAddress(ship_address);
  if (notes) customerObj.Notes = notes;
  if (taxable !== undefined) customerObj.Taxable = taxable;
  if (job !== undefined) customerObj.Job = job;
  if (bill_with_parent !== undefined) customerObj.BillWithParent = bill_with_parent;
  if (preferred_delivery_method) customerObj.PreferredDeliveryMethod = preferred_delivery_method;

  // Resolve parent customer (for subcustomers/jobs)
  let parentName: string | undefined;
  if (parent_ref) {
    const parentCustomer = await resolveCustomer(client, parent_ref);
    customerObj.ParentRef = parentCustomer;
    parentName = parentCustomer.name;
  }

  // Resolve sales term
  let salesTermName: string | undefined;
  if (sales_term_ref) {
    const terms = await promisify<{ QueryResponse: { Term?: Array<{ Id: string; Name: string }> } }>((cb) =>
      (client as unknown as Record<string, Function>).findTerms(cb)
    );
    const termList = terms.QueryResponse?.Term || [];
    const match = termList.find(t =>
      t.Name.toLowerCase() === sales_term_ref.toLowerCase() ||
      t.Id === sales_term_ref
    );
    if (!match) {
      const available = termList.map(t => t.Name).join(', ');
      throw new Error(`Term not found: "${sales_term_ref}". Available: ${available}`);
    }
    customerObj.SalesTermRef = { value: match.Id, name: match.Name };
    salesTermName = match.Name;
  }

  if (draft) {
    const preview = [
      "DRAFT - Customer Preview",
      "",
      `Display Name: ${display_name}`,
      ...(given_name || middle_name || family_name || suffix
        ? [`Name Parts: ${[given_name, middle_name, family_name, suffix].filter(Boolean).join(' ')}`]
        : []),
      `Company: ${company_name || "(none)"}`,
      `Email: ${email || "(none)"}`,
      `Phone: ${phone || "(none)"}`,
      `Mobile: ${mobile || "(none)"}`,
      ...formatAddress(bill_address ? buildQBAddress(bill_address) : undefined, "Billing Address"),
      ...formatAddress(ship_address ? buildQBAddress(ship_address) : undefined, "Shipping Address"),
      `Notes: ${notes || "(none)"}`,
      `Taxable: ${taxable !== undefined ? taxable : "(default)"}`,
      ...(parentName ? [`Parent: ${parentName}`] : []),
      ...(job !== undefined ? [`Job: ${job}`] : []),
      ...(bill_with_parent !== undefined ? [`Bill With Parent: ${bill_with_parent}`] : []),
      ...(preferred_delivery_method ? [`Preferred Delivery: ${preferred_delivery_method}`] : []),
      ...(salesTermName ? [`Terms: ${salesTermName}`] : []),
      "",
      "Set draft=false to create this customer.",
    ].join("\n");

    return { content: [{ type: "text", text: preview }] };
  }

  const result = await promisifyWrite<unknown>((cb) =>
    client.createCustomer(customerObj, cb)
  ) as QBCustomer;

  const qboUrl = buildQboUrl("customerdetail", "nameId", result.Id);

  const response = [
    "Customer Created!",
    "",
    `ID: ${result.Id}`,
    `Display Name: ${result.DisplayName}`,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return { content: [{ type: "text", text: response }] };
}

export async function handleGetCustomer(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const customer = await promisify<unknown>((cb) =>
    client.getCustomer(id, cb)
  ) as QBCustomer;

  const qboUrl = buildQboUrl("customerdetail", "nameId", customer.Id);

  const lines: string[] = [
    "Customer",
    "========",
    `ID: ${customer.Id}`,
    `SyncToken: ${customer.SyncToken}`,
    `Display Name: ${customer.DisplayName}`,
    ...(customer.FullyQualifiedName && customer.FullyQualifiedName !== customer.DisplayName
      ? [`Fully Qualified Name: ${customer.FullyQualifiedName}`] : []),
    `Active: ${customer.Active !== false}`,
    ...(customer.Job ? ['Job: true'] : []),
    ...(customer.ParentRef ? [`Parent: ${customer.ParentRef.name || customer.ParentRef.value}`] : []),
    ...(customer.BillWithParent ? ['Bill With Parent: true'] : []),
  ];

  if (customer.GivenName || customer.MiddleName || customer.FamilyName || customer.Suffix) {
    lines.push(`Name: ${[customer.GivenName, customer.MiddleName, customer.FamilyName, customer.Suffix].filter(Boolean).join(' ')}`);
  }
  if (customer.CompanyName) lines.push(`Company: ${customer.CompanyName}`);
  lines.push(`Email: ${customer.PrimaryEmailAddr?.Address || "(none)"}`);
  lines.push(`Phone: ${customer.PrimaryPhone?.FreeFormNumber || "(none)"}`);
  lines.push(`Mobile: ${customer.Mobile?.FreeFormNumber || "(none)"}`);
  lines.push(`Preferred Delivery: ${customer.PreferredDeliveryMethod || "(none)"}`);
  lines.push(`Terms: ${customer.SalesTermRef?.name || "(none)"}`);
  lines.push(...formatAddress(customer.BillAddr, "Billing Address"));
  lines.push(...formatAddress(customer.ShipAddr, "Shipping Address"));
  if (customer.Notes) lines.push(`Notes: ${customer.Notes}`);
  lines.push(`Taxable: ${customer.Taxable ?? "(default)"}`);
  lines.push(`Balance: $${(customer.Balance || 0).toFixed(2)}`);
  if (customer.BalanceWithJobs !== undefined && customer.BalanceWithJobs !== customer.Balance) {
    lines.push(`Balance (with jobs): $${customer.BalanceWithJobs.toFixed(2)}`);
  }
  lines.push("");
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`customer-${customer.Id}`, customer, lines.join("\n"));
}

export async function handleEditCustomer(
  client: QuickBooks,
  args: {
    id: string;
    display_name?: string;
    given_name?: string;
    middle_name?: string;
    family_name?: string;
    suffix?: string;
    company_name?: string;
    email?: string;
    phone?: string;
    mobile?: string;
    bill_address?: AddressInput;
    ship_address?: AddressInput;
    notes?: string;
    taxable?: boolean;
    active?: boolean;
    parent_ref?: string;
    job?: boolean;
    bill_with_parent?: boolean;
    preferred_delivery_method?: string;
    sales_term_ref?: string;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    id, display_name, given_name, middle_name, family_name, suffix,
    company_name, email, phone, mobile,
    bill_address, ship_address, notes, taxable, active,
    parent_ref, job, bill_with_parent, preferred_delivery_method, sales_term_ref,
    draft = true,
  } = args;

  // Fetch current customer
  const current = await promisify<unknown>((cb) =>
    client.getCustomer(id, cb)
  ) as QBCustomer;

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
  if (company_name !== undefined) updated.CompanyName = company_name;
  if (email !== undefined) updated.PrimaryEmailAddr = { Address: email };
  if (phone !== undefined) updated.PrimaryPhone = { FreeFormNumber: phone };
  if (mobile !== undefined) updated.Mobile = { FreeFormNumber: mobile };
  if (bill_address !== undefined) updated.BillAddr = buildQBAddress(bill_address);
  if (ship_address !== undefined) updated.ShipAddr = buildQBAddress(ship_address);
  if (notes !== undefined) updated.Notes = notes;
  if (taxable !== undefined) updated.Taxable = taxable;
  if (active !== undefined) updated.Active = active;
  if (job !== undefined) updated.Job = job;
  if (bill_with_parent !== undefined) updated.BillWithParent = bill_with_parent;
  if (preferred_delivery_method !== undefined) updated.PreferredDeliveryMethod = preferred_delivery_method;

  // Resolve parent customer if provided
  if (parent_ref !== undefined) {
    const parentCustomer = await resolveCustomer(client, parent_ref);
    updated.ParentRef = parentCustomer;
  }

  // Resolve sales term if provided
  if (sales_term_ref !== undefined) {
    const terms = await promisify<{ QueryResponse: { Term?: Array<{ Id: string; Name: string }> } }>((cb) =>
      (client as unknown as Record<string, Function>).findTerms(cb)
    );
    const termList = terms.QueryResponse?.Term || [];
    const match = termList.find(t =>
      t.Name.toLowerCase() === sales_term_ref.toLowerCase() ||
      t.Id === sales_term_ref
    );
    if (!match) {
      const available = termList.map(t => t.Name).join(', ');
      throw new Error(`Term not found: "${sales_term_ref}". Available: ${available}`);
    }
    updated.SalesTermRef = { value: match.Id, name: match.Name };
  }

  const qboUrl = buildQboUrl("customerdetail", "nameId", id);

  if (draft) {
    const previewLines: string[] = [
      "DRAFT - Customer Edit Preview",
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
    if (company_name !== undefined) previewLines.push(`  Company: ${current.CompanyName || "(none)"} → ${company_name}`);
    if (email !== undefined) previewLines.push(`  Email: ${current.PrimaryEmailAddr?.Address || "(none)"} → ${email}`);
    if (phone !== undefined) previewLines.push(`  Phone: ${current.PrimaryPhone?.FreeFormNumber || "(none)"} → ${phone}`);
    if (mobile !== undefined) previewLines.push(`  Mobile: ${current.Mobile?.FreeFormNumber || "(none)"} → ${mobile}`);
    if (bill_address !== undefined) previewLines.push("  Billing Address: (updating)");
    if (ship_address !== undefined) previewLines.push("  Shipping Address: (updating)");
    if (notes !== undefined) previewLines.push(`  Notes: ${current.Notes || "(none)"} → ${notes}`);
    if (taxable !== undefined) previewLines.push(`  Taxable: ${current.Taxable ?? "(default)"} → ${taxable}`);
    if (active !== undefined) previewLines.push(`  Active: ${current.Active !== false} → ${active}`);
    if (parent_ref !== undefined) {
      const newParent = (updated.ParentRef as { name?: string })?.name || parent_ref;
      previewLines.push(`  Parent: ${current.ParentRef?.name || '(none)'} → ${newParent}`);
    }
    if (job !== undefined) previewLines.push(`  Job: ${current.Job ?? false} → ${job}`);
    if (bill_with_parent !== undefined) previewLines.push(`  Bill With Parent: ${current.BillWithParent ?? false} → ${bill_with_parent}`);
    if (preferred_delivery_method !== undefined) previewLines.push(`  Preferred Delivery: ${current.PreferredDeliveryMethod || '(none)'} → ${preferred_delivery_method}`);
    if (sales_term_ref !== undefined) {
      const newTerm = (updated.SalesTermRef as { name?: string })?.name || sales_term_ref;
      previewLines.push(`  Terms: ${current.SalesTermRef?.name || '(none)'} → ${newTerm}`);
    }

    previewLines.push("");
    previewLines.push("Set draft=false to apply these changes.");

    return { content: [{ type: "text", text: previewLines.join("\n") }] };
  }

  const result = await promisifyWrite<unknown>((cb) =>
    client.updateCustomer(updated, cb)
  ) as QBCustomer;

  return {
    content: [{
      type: "text",
      text: formatUpdateResult("Customer", id, current.SyncToken, result.SyncToken, qboUrl),
    }],
  };
}
