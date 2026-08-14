// Handlers for sales receipt tools (get, edit)

import QuickBooks from "node-quickbooks";
import {
  promisify,
  getAccountCache,
  getDepartmentCache,
  resolveItem,
  resolveCustomer,
  resolveAccountRef,
  toQboRef,
} from "../../client/index.js";
import { buildQboUrl, validateAmount, toDollars, formatDollars, sumCents, outputReport } from "../../utils/index.js";

interface SalesReceiptLineChange {
  line_id?: string;
  item_name?: string;
  item_id?: string;
  amount?: number;
  qty?: number;
  unit_price?: number;
  description?: string;
  delete?: boolean;
}

interface CreateSalesReceiptLine {
  item_name?: string;
  item_id?: string;
  amount?: number;
  qty?: number;
  unit_price?: number;
  description?: string;
}

export async function handleCreateSalesReceipt(
  client: QuickBooks,
  args: {
    txn_date: string;
    customer_name?: string;
    customer_id?: string;
    deposit_to_account?: string;
    department_name?: string;
    department_id?: string;
    memo?: string;
    doc_number?: string;
    lines: CreateSalesReceiptLine[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    txn_date, customer_name, customer_id,
    deposit_to_account, department_name, department_id,
    memo, doc_number, lines, draft = true,
  } = args;

  if (!lines || lines.length === 0) {
    throw new Error("At least one line is required");
  }

  // Resolve customer (optional)
  let customerRef: { value: string; name: string } | undefined;
  if (customer_id) {
    customerRef = await resolveCustomer(client, customer_id);
  } else if (customer_name) {
    customerRef = await resolveCustomer(client, customer_name);
  }

  // Resolve deposit account (optional)
  let depositAccountRef: { value: string; name: string } | undefined;
  if (deposit_to_account) {
    const acctCache = await getAccountCache(client);
    depositAccountRef = toQboRef(
      resolveAccountRef(acctCache, deposit_to_account, { label: "Deposit account" })
    );
  }

  // Resolve department (header-level, optional)
  let departmentRef: { value: string; name: string } | undefined;
  const deptInput = department_id || department_name;
  if (deptInput) {
    const deptCache = await getDepartmentCache(client);
    const byId = deptCache.byId.get(deptInput);
    if (byId) {
      departmentRef = { value: byId.Id, name: byId.FullyQualifiedName || byId.Name };
    } else {
      const byName = deptCache.byName.get(deptInput.toLowerCase());
      if (byName) {
        departmentRef = { value: byName.Id, name: byName.FullyQualifiedName || byName.Name };
      } else {
        const byPartial = deptCache.items.find(d =>
          d.FullyQualifiedName?.toLowerCase().includes(deptInput.toLowerCase())
        );
        if (byPartial) {
          departmentRef = { value: byPartial.Id, name: byPartial.FullyQualifiedName || byPartial.Name };
        } else {
          throw new Error(`Department not found: "${deptInput}"`);
        }
      }
    }
  }

  // Resolve lines
  const resolvedLines = await Promise.all(lines.map(async (line) => {
    const itemInput = line.item_name || line.item_id;
    if (!itemInput) {
      throw new Error("Each line must have either item_name or item_id");
    }
    if (line.amount === undefined && (line.qty === undefined || line.unit_price === undefined)) {
      throw new Error(`Line for "${itemInput}" requires amount, or both qty and unit_price`);
    }

    const itemRef = await resolveItem(client, itemInput);

    const qty = line.qty ?? 1;
    let amountCents: number;
    let unitPriceDollars: number;

    if (line.amount !== undefined) {
      amountCents = validateAmount(line.amount, `Line for ${itemRef.name}`);
      unitPriceDollars = toDollars(amountCents) / qty;
    } else {
      const upCents = validateAmount(line.unit_price!, `Line unit_price for ${itemRef.name}`);
      unitPriceDollars = toDollars(upCents);
      amountCents = upCents * qty;
    }

    return {
      itemRef,
      qty,
      unitPriceDollars,
      amountCents,
      amountDollars: toDollars(amountCents),
      description: line.description,
    };
  }));

  // Calculate total
  const totalCents = sumCents(resolvedLines.map(l => l.amountCents));

  // Build QuickBooks SalesReceipt object
  const srObject: Record<string, unknown> = {
    TxnDate: txn_date,
    ...(customerRef && { CustomerRef: customerRef }),
    ...(depositAccountRef && { DepositToAccountRef: depositAccountRef }),
    ...(departmentRef && { DepartmentRef: departmentRef }),
    ...(memo && { PrivateNote: memo }),
    ...(doc_number && { DocNumber: doc_number }),
    Line: resolvedLines.map((line) => ({
      Amount: line.amountDollars,
      DetailType: "SalesItemLineDetail",
      ...(line.description && { Description: line.description }),
      SalesItemLineDetail: {
        ItemRef: line.itemRef,
        Qty: line.qty,
        UnitPrice: line.unitPriceDollars,
      },
    })),
  };

  if (draft) {
    const preview = [
      "DRAFT - Sales Receipt Preview",
      "",
      `Customer: ${customerRef?.name || "(none)"}`,
      `Date: ${txn_date}`,
      `Ref no.: ${doc_number || "(auto-assign)"}`,
      `Deposit To: ${depositAccountRef?.name || "(default)"}`,
      `Department: ${departmentRef?.name || "(none)"}`,
      `Memo: ${memo || "(none)"}`,
      `Total: $${formatDollars(totalCents)}`,
      "",
      "Lines:",
      ...resolvedLines.map(l =>
        `  ${l.itemRef.name}: Qty ${l.qty} × $${l.unitPriceDollars.toFixed(2)} = $${l.amountDollars.toFixed(2)}${l.description ? ` "${l.description}"` : ""}`
      ),
      "",
      "Set draft=false to create this sales receipt.",
    ].join("\n");

    return {
      content: [{ type: "text", text: preview }],
    };
  }

  // Create the sales receipt
  const result = await promisify<unknown>((cb) =>
    client.createSalesReceipt(srObject, cb)
  ) as { Id: string; DocNumber?: string };

  const qboUrl = buildQboUrl("salesreceipt", "txnId", result.Id);

  const response = [
    "Sales Receipt Created!",
    "",
    `Customer: ${customerRef?.name || "(none)"}`,
    `Ref no.: ${result.DocNumber || "(auto-assigned)"}`,
    `Date: ${txn_date}`,
    `Total: $${formatDollars(totalCents)}`,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return {
    content: [{ type: "text", text: response }],
  };
}

export async function handleGetSalesReceipt(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const salesReceipt = await promisify<unknown>((cb) =>
    client.getSalesReceipt(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DocNumber?: string;
    PrivateNote?: string;
    TotalAmt?: number;
    CustomerRef?: { value: string; name?: string };
    DepositToAccountRef?: { value: string; name?: string };
    DepartmentRef?: { value: string; name?: string };
    Line?: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      SalesItemLineDetail?: {
        ItemRef: { value: string; name?: string };
        Qty?: number;
        UnitPrice?: number;
        ItemAccountRef?: { value: string; name?: string };
        ClassRef?: { value: string; name?: string };
        TaxCodeRef?: { value: string; name?: string };
      };
    }>;
  };
  const qboUrl = buildQboUrl("salesreceipt", "txnId", salesReceipt.Id);

  // Format summary
  const lines: string[] = [
    'Sales Receipt',
    '=============',
    `ID: ${salesReceipt.Id}`,
    `SyncToken: ${salesReceipt.SyncToken}`,
    `Customer: ${salesReceipt.CustomerRef?.name || salesReceipt.CustomerRef?.value || '(none)'}`,
    `Date: ${salesReceipt.TxnDate}`,
    `Ref no.: ${salesReceipt.DocNumber || '(none)'}`,
    `Deposit To: ${salesReceipt.DepositToAccountRef?.name || salesReceipt.DepositToAccountRef?.value || '(default)'}`,
    `Department: ${salesReceipt.DepartmentRef?.name || salesReceipt.DepartmentRef?.value || '(none)'}`,
    `Memo: ${salesReceipt.PrivateNote || '(none)'}`,
    `Total: $${(salesReceipt.TotalAmt || 0).toFixed(2)}`,
    '',
    'Lines:',
  ];

  for (const line of salesReceipt.Line || []) {
    if (line.SalesItemLineDetail) {
      const detail = line.SalesItemLineDetail;
      const itemName = detail.ItemRef?.name || detail.ItemRef?.value || '(no item)';
      const qty = detail.Qty ?? 1;
      const unitPrice = detail.UnitPrice ?? line.Amount;
      const acctStr = detail.ItemAccountRef?.name ? ` → ${detail.ItemAccountRef.name}` : '';
      const descStr = line.Description ? ` "${line.Description}"` : '';
      lines.push(`  Line ${line.Id}: ${itemName} (Qty: ${qty} × $${unitPrice.toFixed(2)}) = $${line.Amount.toFixed(2)}${acctStr}${descStr}`);
    } else if (line.DetailType === 'SubTotalLineDetail') {
      lines.push(`  SubTotal: $${line.Amount.toFixed(2)}`);
    }
  }

  lines.push('');
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`salesreceipt-${salesReceipt.Id}`, salesReceipt, lines.join('\n'));
}

export async function handleEditSalesReceipt(
  client: QuickBooks,
  args: {
    id: string;
    txn_date?: string;
    memo?: string;
    customer_name?: string;
    deposit_to_account?: string;
    department_name?: string;
    lines?: SalesReceiptLineChange[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id, txn_date, memo, customer_name, deposit_to_account, department_name, lines: lineChanges, draft = true } = args;

  // Fetch current SalesReceipt
  const current = await promisify<unknown>((cb) =>
    client.getSalesReceipt(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DocNumber?: string;
    PrivateNote?: string;
    CustomerRef?: { value: string; name?: string };
    DepositToAccountRef?: { value: string; name?: string };
    DepartmentRef?: { value: string; name?: string };
    Line: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      SalesItemLineDetail?: {
        ItemRef: { value: string; name?: string };
        Qty?: number;
        UnitPrice?: number;
        ItemAccountRef?: { value: string; name?: string };
        ClassRef?: { value: string; name?: string };
        TaxCodeRef?: { value: string; name?: string };
      };
    }>;
  };

  // Always sparse. A full update nulls every writable field absent from the
  // payload, which silently cleared CustomerRef on any line edit. Sparse also
  // handles line changes (including deletion) provided the complete Line array
  // is sent. See docs/quickbooks-api-limitations.md.
  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    sparse: true,
  };

  if (lineChanges && lineChanges.length > 0) {
    // Seed with the existing lines, stripping read-only fields
    updated.Line = current.Line.map(line => {
      const { LineNum, ...rest } = line as Record<string, unknown>;
      return rest;
    });
  }

  if (txn_date !== undefined) updated.TxnDate = txn_date;
  if (memo !== undefined) updated.PrivateNote = memo;

  // Resolve customer if provided
  if (customer_name !== undefined) {
    updated.CustomerRef = await resolveCustomer(client, customer_name);
  }

  // Resolve deposit_to_account if provided (needs account cache)
  if (deposit_to_account !== undefined) {
    const { getAccountCache } = await import("../../client/index.js");
    const acctCache = await getAccountCache(client);
    updated.DepositToAccountRef = toQboRef(
      resolveAccountRef(acctCache, deposit_to_account, { label: "Deposit account" })
    );
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
    for (const change of lineChanges) {
      if (change.line_id) {
        const lineIndex = finalLines.findIndex(l => l.Id === change.line_id);
        if (lineIndex === -1) {
          throw new Error(`Line ID ${change.line_id} not found in sales receipt`);
        }

        if (change.delete) {
          finalLines.splice(lineIndex, 1);
        } else {
          const line = { ...finalLines[lineIndex] };
          const detail = { ...(line.SalesItemLineDetail || {}) } as {
            ItemRef?: { value: string; name?: string };
            Qty?: number;
            UnitPrice?: number;
            ItemAccountRef?: { value: string; name?: string };
            TaxCodeRef?: { value: string; name?: string };
          };

          if (change.amount !== undefined) {
            const amountCents = validateAmount(change.amount, `Line ${change.line_id}`);
            line.Amount = toDollars(amountCents);
            // Update UnitPrice to match if Qty is 1 (common case)
            if (detail.Qty === 1 || detail.Qty === undefined) {
              detail.UnitPrice = toDollars(amountCents);
            }
          }
          if (change.description !== undefined) line.Description = change.description;

          line.SalesItemLineDetail = detail as typeof line.SalesItemLineDetail;
          line.DetailType = 'SalesItemLineDetail';
          finalLines[lineIndex] = line;
        }
      } else {
        // New line — requires item reference
        const itemInput = change.item_name || change.item_id;
        if (!itemInput) {
          throw new Error('New lines require item_name or item_id');
        }
        if (change.amount === undefined && (change.qty === undefined || change.unit_price === undefined)) {
          throw new Error('New lines require amount, or both qty and unit_price');
        }

        const itemRef = await resolveItem(client, itemInput);

        const qty = change.qty ?? 1;
        let amountCents: number;
        let unitPriceDollars: number;

        if (change.amount !== undefined) {
          amountCents = validateAmount(change.amount, `New line for ${itemRef.name}`);
          unitPriceDollars = toDollars(amountCents) / qty;
        } else {
          const upCents = validateAmount(change.unit_price!, `New line unit_price for ${itemRef.name}`);
          unitPriceDollars = toDollars(upCents);
          amountCents = upCents * qty;
        }

        const newLine = {
          DetailType: 'SalesItemLineDetail',
          Amount: toDollars(amountCents),
          ...(change.description && { Description: change.description }),
          SalesItemLineDetail: {
            ItemRef: itemRef,
            Qty: qty,
            UnitPrice: unitPriceDollars,
          },
        } as typeof finalLines[0];
        finalLines.push(newLine);
      }
    }

    updated.Line = finalLines;
  }

  const qboUrl = buildQboUrl("salesreceipt", "txnId", id);

  if (draft) {
    const previewLines: string[] = [
      'DRAFT - Sales Receipt Edit Preview',
      '',
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      '',
      'Changes:',
    ];

    if (txn_date !== undefined) previewLines.push(`  Date: ${current.TxnDate} → ${txn_date}`);
    if (memo !== undefined) previewLines.push(`  Memo: ${current.PrivateNote || '(none)'} → ${memo}`);
    if (customer_name !== undefined) {
      const newCust = (updated.CustomerRef as { name?: string })?.name || customer_name;
      previewLines.push(`  Customer: ${current.CustomerRef?.name || '(none)'} → ${newCust}`);
    }
    if (deposit_to_account !== undefined) {
      const newAcct = (updated.DepositToAccountRef as { name?: string })?.name || deposit_to_account;
      previewLines.push(`  Deposit To: ${current.DepositToAccountRef?.name || '(default)'} → ${newAcct}`);
    }
    if (department_name !== undefined) {
      const newDept = (updated.DepartmentRef as { name?: string })?.name || department_name;
      previewLines.push(`  Department: ${current.DepartmentRef?.name || '(none)'} → ${newDept}`);
    }

    if (updated.Line) {
      previewLines.push('');
      previewLines.push('Updated Lines:');
      for (const line of updated.Line as typeof finalLines) {
        const detail = line.SalesItemLineDetail;
        if (detail) {
          const itemName = detail.ItemRef?.name || detail.ItemRef?.value || '(item)';
          const descStr = line.Description ? ` "${line.Description}"` : '';
          previewLines.push(`  ${itemName}: $${line.Amount.toFixed(2)}${descStr}`);
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
    client.updateSalesReceipt(updated, cb)
  ) as { Id: string; SyncToken: string };

  return {
    content: [{ type: "text", text: `Sales Receipt ${id} updated successfully.\nNew SyncToken: ${result.SyncToken}\nView in QuickBooks: ${qboUrl}` }],
  };
}
