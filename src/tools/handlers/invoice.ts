// Handlers for invoice tools (create, get, edit)

import QuickBooks from "node-quickbooks";
import {
  promisify,
  promisifyWrite,
  getAccountCache,
  getDepartmentCache,
  resolveItem,
  resolveCustomer,
} from "../../client/index.js";
import { buildQboUrl, validateAmount, toDollars, formatDollars, sumCents, outputReport } from "../../utils/index.js";

interface InvoiceLineChange {
  line_id?: string;
  item_name?: string;
  item_id?: string;
  amount?: number;
  qty?: number;
  unit_price?: number;
  description?: string;
  delete?: boolean;
}

interface CreateInvoiceLine {
  item_name?: string;
  item_id?: string;
  amount?: number;
  qty?: number;
  unit_price?: number;
  description?: string;
}

export async function handleCreateInvoice(
  client: QuickBooks,
  args: {
    txn_date: string;
    customer_name?: string;
    customer_id?: string;
    due_date?: string;
    department_name?: string;
    department_id?: string;
    memo?: string;
    customer_memo?: string;
    bill_email?: string;
    sales_term_ref?: string;
    allow_online_credit_card_payment?: boolean;
    allow_online_ach_payment?: boolean;
    doc_number?: string;
    lines: CreateInvoiceLine[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    txn_date, customer_name, customer_id,
    due_date, department_name, department_id,
    memo, customer_memo, bill_email, sales_term_ref,
    allow_online_credit_card_payment, allow_online_ach_payment,
    doc_number, lines, draft = true,
  } = args;

  if (!lines || lines.length === 0) {
    throw new Error("At least one line is required");
  }

  // Resolve customer (required for invoices)
  if (!customer_id && !customer_name) {
    throw new Error("Either customer_name or customer_id is required for invoices");
  }
  let customerRef: { value: string; name: string };
  if (customer_id) {
    customerRef = await resolveCustomer(client, customer_id);
  } else {
    customerRef = await resolveCustomer(client, customer_name!);
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

  // Resolve sales term (optional)
  let salesTermRef: { value: string; name: string } | undefined;
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
    salesTermRef = { value: match.Id, name: match.Name };
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

  // Build QuickBooks Invoice object
  const invObject: Record<string, unknown> = {
    TxnDate: txn_date,
    CustomerRef: customerRef,
    ...(due_date && { DueDate: due_date }),
    ...(departmentRef && { DepartmentRef: departmentRef }),
    ...(salesTermRef && { SalesTermRef: salesTermRef }),
    ...(memo && { PrivateNote: memo }),
    ...(customer_memo && { CustomerMemo: { value: customer_memo } }),
    ...(bill_email && { BillEmail: { Address: bill_email } }),
    ...(allow_online_credit_card_payment !== undefined && { AllowOnlineCreditCardPayment: allow_online_credit_card_payment }),
    ...(allow_online_ach_payment !== undefined && { AllowOnlineACHPayment: allow_online_ach_payment }),
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
      "DRAFT - Invoice Preview",
      "",
      `Customer: ${customerRef.name}`,
      `Date: ${txn_date}`,
      `Due Date: ${due_date || "(none)"}`,
      `Terms: ${salesTermRef?.name || "(none)"}`,
      `Ref no.: ${doc_number || "(auto-assign)"}`,
      `Department: ${departmentRef?.name || "(none)"}`,
      `Memo: ${memo || "(none)"}`,
      `Customer Memo: ${customer_memo || "(none)"}`,
      `Bill Email: ${bill_email || "(none)"}`,
      ...(allow_online_credit_card_payment !== undefined ? [`Online CC Payment: ${allow_online_credit_card_payment}`] : []),
      ...(allow_online_ach_payment !== undefined ? [`Online ACH Payment: ${allow_online_ach_payment}`] : []),
      `Total: $${formatDollars(totalCents)}`,
      "",
      "Lines:",
      ...resolvedLines.map(l =>
        `  ${l.itemRef.name}: Qty ${l.qty} × $${l.unitPriceDollars.toFixed(2)} = $${l.amountDollars.toFixed(2)}${l.description ? ` "${l.description}"` : ""}`
      ),
      "",
      "Set draft=false to create this invoice.",
    ].join("\n");

    return {
      content: [{ type: "text", text: preview }],
    };
  }

  // Create the invoice
  const result = await promisifyWrite<unknown>((cb) =>
    client.createInvoice(invObject, cb)
  ) as { Id: string; DocNumber?: string };

  const qboUrl = buildQboUrl("invoice", "txnId", result.Id);

  const response = [
    "Invoice Created!",
    "",
    `Customer: ${customerRef.name}`,
    `Ref no.: ${result.DocNumber || "(auto-assigned)"}`,
    `Date: ${txn_date}`,
    `Due Date: ${due_date || "(none)"}`,
    `Total: $${formatDollars(totalCents)}`,
    "",
    `View in QuickBooks: ${qboUrl}`,
  ].join("\n");

  return {
    content: [{ type: "text", text: response }],
  };
}

export async function handleGetInvoice(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const invoice = await promisify<unknown>((cb) =>
    client.getInvoice(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DueDate?: string;
    DocNumber?: string;
    PrivateNote?: string;
    TotalAmt?: number;
    Balance?: number;
    CustomerRef?: { value: string; name?: string };
    DepartmentRef?: { value: string; name?: string };
    BillEmail?: { Address?: string };
    CustomerMemo?: { value?: string };
    EmailStatus?: string;
    LinkedTxn?: Array<{ TxnId: string; TxnType: string }>;
    AllowOnlineCreditCardPayment?: boolean;
    AllowOnlineACHPayment?: boolean;
    SalesTermRef?: { value: string; name?: string };
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
  const qboUrl = buildQboUrl("invoice", "txnId", invoice.Id);

  // Format summary
  const lines: string[] = [
    'Invoice',
    '=======',
    `ID: ${invoice.Id}`,
    `SyncToken: ${invoice.SyncToken}`,
    `Customer: ${invoice.CustomerRef?.name || invoice.CustomerRef?.value || '(none)'}`,
    `Date: ${invoice.TxnDate}`,
    `Due Date: ${invoice.DueDate || '(none)'}`,
    `Ref no.: ${invoice.DocNumber || '(none)'}`,
    `Department: ${invoice.DepartmentRef?.name || invoice.DepartmentRef?.value || '(none)'}`,
    `Terms: ${invoice.SalesTermRef?.name || '(none)'}`,
    `Memo: ${invoice.PrivateNote || '(none)'}`,
    `Customer Memo: ${invoice.CustomerMemo?.value || '(none)'}`,
    `Bill Email: ${invoice.BillEmail?.Address || '(none)'}`,
    `Email Status: ${invoice.EmailStatus || '(none)'}`,
    `Online CC Payment: ${invoice.AllowOnlineCreditCardPayment ?? '(not set)'}`,
    `Online ACH Payment: ${invoice.AllowOnlineACHPayment ?? '(not set)'}`,
    `Total: $${(invoice.TotalAmt || 0).toFixed(2)}`,
    `Balance: $${(invoice.Balance || 0).toFixed(2)}`,
  ];

  if (invoice.LinkedTxn && invoice.LinkedTxn.length > 0) {
    lines.push('');
    lines.push('Linked Transactions:');
    for (const linked of invoice.LinkedTxn) {
      lines.push(`  ${linked.TxnType} #${linked.TxnId}`);
    }
  }

  lines.push('');
  lines.push('Lines:');

  for (const line of invoice.Line || []) {
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

  return outputReport(`invoice-${invoice.Id}`, invoice, lines.join('\n'));
}

export async function handleEditInvoice(
  client: QuickBooks,
  args: {
    id: string;
    txn_date?: string;
    due_date?: string;
    memo?: string;
    customer_memo?: string;
    bill_email?: string;
    sales_term_ref?: string;
    allow_online_credit_card_payment?: boolean;
    allow_online_ach_payment?: boolean;
    customer_name?: string;
    department_name?: string;
    lines?: InvoiceLineChange[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    id, txn_date, due_date, memo, customer_memo, bill_email,
    sales_term_ref, allow_online_credit_card_payment, allow_online_ach_payment,
    customer_name, department_name, lines: lineChanges, draft = true,
  } = args;

  // Fetch current Invoice
  const current = await promisify<unknown>((cb) =>
    client.getInvoice(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DueDate?: string;
    DocNumber?: string;
    PrivateNote?: string;
    CustomerRef?: { value: string; name?: string };
    DepartmentRef?: { value: string; name?: string };
    CustomerMemo?: { value?: string };
    BillEmail?: { Address?: string };
    SalesTermRef?: { value: string; name?: string };
    AllowOnlineCreditCardPayment?: boolean;
    AllowOnlineACHPayment?: boolean;
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

  // Determine if we're modifying lines - requires full update (not sparse)
  const needsLineRebuild = lineChanges && lineChanges.length > 0;

  // Build updated Invoice
  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
  };

  // Always sparse. A full update nulls every writable field absent from the
  // payload, which is why this handler had grown a long copy list. Sparse also
  // handles line changes, including deletion, provided the complete Line array
  // is sent. See docs/quickbooks-api-limitations.md.
  updated.sparse = true;

  if (needsLineRebuild) {
    // Seed with the existing lines, stripping read-only fields
    updated.Line = current.Line.map(line => {
      const { LineNum, ...rest } = line as Record<string, unknown>;
      return rest;
    });
  }

  if (txn_date !== undefined) updated.TxnDate = txn_date;
  if (due_date !== undefined) updated.DueDate = due_date;
  if (memo !== undefined) updated.PrivateNote = memo;
  if (customer_memo !== undefined) updated.CustomerMemo = { value: customer_memo };
  if (bill_email !== undefined) updated.BillEmail = { Address: bill_email };
  if (allow_online_credit_card_payment !== undefined) updated.AllowOnlineCreditCardPayment = allow_online_credit_card_payment;
  if (allow_online_ach_payment !== undefined) updated.AllowOnlineACHPayment = allow_online_ach_payment;

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

  // Resolve customer if provided
  if (customer_name !== undefined) {
    const customerRef = await resolveCustomer(client, customer_name);
    updated.CustomerRef = customerRef;
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
  let finalLines = [...((updated.Line as typeof current.Line) || current.Line)];

  if (lineChanges && lineChanges.length > 0) {
    for (const change of lineChanges) {
      if (change.line_id) {
        const lineIndex = finalLines.findIndex(l => l.Id === change.line_id);
        if (lineIndex === -1) {
          throw new Error(`Line ID ${change.line_id} not found in invoice`);
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

  const qboUrl = buildQboUrl("invoice", "txnId", id);

  if (draft) {
    const previewLines: string[] = [
      'DRAFT - Invoice Edit Preview',
      '',
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      '',
      'Changes:',
    ];

    if (txn_date !== undefined) previewLines.push(`  Date: ${current.TxnDate} → ${txn_date}`);
    if (due_date !== undefined) previewLines.push(`  Due Date: ${current.DueDate || '(none)'} → ${due_date}`);
    if (memo !== undefined) previewLines.push(`  Memo: ${current.PrivateNote || '(none)'} → ${memo}`);
    if (customer_memo !== undefined) previewLines.push(`  Customer Memo: ${current.CustomerMemo?.value || '(none)'} → ${customer_memo}`);
    if (bill_email !== undefined) previewLines.push(`  Bill Email: ${current.BillEmail?.Address || '(none)'} → ${bill_email}`);
    if (sales_term_ref !== undefined) {
      const newTerm = (updated.SalesTermRef as { name?: string })?.name || sales_term_ref;
      previewLines.push(`  Terms: ${current.SalesTermRef?.name || '(none)'} → ${newTerm}`);
    }
    if (allow_online_credit_card_payment !== undefined) previewLines.push(`  Online CC Payment: ${current.AllowOnlineCreditCardPayment ?? '(not set)'} → ${allow_online_credit_card_payment}`);
    if (allow_online_ach_payment !== undefined) previewLines.push(`  Online ACH Payment: ${current.AllowOnlineACHPayment ?? '(not set)'} → ${allow_online_ach_payment}`);
    if (customer_name !== undefined) {
      const newCust = (updated.CustomerRef as { name?: string })?.name || customer_name;
      previewLines.push(`  Customer: ${current.CustomerRef?.name || '(none)'} → ${newCust}`);
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

  const result = await promisifyWrite<unknown>((cb) =>
    client.updateInvoice(updated, cb)
  ) as { Id: string; SyncToken: string };

  return {
    content: [{ type: "text", text: `Invoice ${id} updated successfully.\nNew SyncToken: ${result.SyncToken}\nView in QuickBooks: ${qboUrl}` }],
  };
}
