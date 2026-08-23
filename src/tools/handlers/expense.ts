// Handlers for expense tools (create, get, edit)

import QuickBooks from "node-quickbooks";
import {
  promisify,
  promisifyWrite,
  getAccountCache,
  getDepartmentCache,
  resolveAccountRef,
  resolveEntityRef,
  resolveCustomerInput,
  normalizeEntityKind,
  toPurchaseEntityRef,
  toQboRef,
} from "../../client/index.js";
import { buildQboUrl, validateAmount, toDollars, formatDollars, sumCents, outputReport } from "../../utils/index.js";

interface CreateExpenseLine {
  account_id?: string;
  account_name?: string;
  amount: number;
  description?: string;
  customer_name?: string;
  customer_id?: string;
}

interface ExpenseLineChange {
  line_id?: string;
  account_name?: string;
  amount?: number;
  description?: string;
  customer_name?: string;
  customer_id?: string;
  delete?: boolean;
}

// AccountBasedExpenseLineDetail attributes a line to a customer and nothing
// else — there is no Vendor or Employee option at line level, which is why
// these lines take customer_name rather than entity_name/entity_type. The payee
// (vendor, customer, or employee) is the header EntityRef.

export async function handleCreateExpense(
  client: QuickBooks,
  args: {
    payment_type: "Cash" | "Check" | "CreditCard";
    payment_account: string;
    txn_date: string;
    entity_name?: string;
    entity_id?: string;
    entity_type?: string;
    department_name?: string;
    department_id?: string;
    memo?: string;
    doc_number?: string;
    lines: CreateExpenseLine[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    payment_type, payment_account, txn_date,
    entity_name, entity_id, entity_type,
    department_name, department_id,
    memo, doc_number, lines, draft = true,
  } = args;

  if (!lines || lines.length === 0) {
    throw new Error("At least one line is required");
  }

  // Get cached lookups in parallel
  const [acctCache, deptCache] = await Promise.all([
    getAccountCache(client),
    getDepartmentCache(client),
  ]);

  // Resolve payment account (acctNum is kept for the draft preview)
  const paymentAcct = resolveAccountRef(acctCache, payment_account);
  const paymentAccountRef = toQboRef(paymentAcct);

  // Resolve the payee (optional). QBO lets a Purchase be paid to a vendor,
  // customer, or employee; entity_type picks which name list to search and
  // defaults to Vendor.
  let entityRef: { value: string; name: string; type: string } | undefined;
  const entityInput = entity_id || entity_name;
  if (entityInput) {
    entityRef = toPurchaseEntityRef(
      await resolveEntityRef(client, entityInput, normalizeEntityKind(entity_type))
    );
  }

  // Resolve department (header-level, optional)
  let departmentRef: { value: string; name: string } | undefined;
  const deptInput = department_id || department_name;
  if (deptInput) {
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

  // Resolve lines. Customer resolution can hit the API, so this is a loop.
  const resolvedLines: Array<CreateExpenseLine & {
    account_id: string;
    account_num?: string;
    amount_cents: number;
    customer_ref?: { value: string; name: string };
  }> = [];
  for (const line of lines) {
    let accountId = line.account_id;
    let accountName = line.account_name;
    let accountNum: string | undefined;

    if (!accountId && accountName) {
      const account = resolveAccountRef(acctCache, accountName);
      accountId = account.value;
      accountName = account.name;
      accountNum = account.acctNum;
    } else if (!accountId && !accountName) {
      throw new Error("Each line must have either account_id or account_name");
    }

    const amountCents = validateAmount(line.amount, `Line ${accountName || accountId}`);
    const customerRef = await resolveCustomerInput(client, line, `Line ${accountName || accountId}`);

    resolvedLines.push({
      ...line,
      account_id: accountId!,
      account_name: accountName,
      account_num: accountNum,
      amount_cents: amountCents,
      customer_ref: customerRef ?? undefined,
      amount: toDollars(amountCents),
    });
  }

  // Calculate total
  const totalCents = sumCents(resolvedLines.map(l => l.amount_cents));

  // Build QuickBooks Purchase object
  const purchaseObject: Record<string, unknown> = {
    PaymentType: payment_type,
    AccountRef: paymentAccountRef,
    TxnDate: txn_date,
    ...(entityRef && { EntityRef: entityRef }),
    ...(departmentRef && { DepartmentRef: departmentRef }),
    ...(memo && { PrivateNote: memo }),
    ...(doc_number && { DocNumber: doc_number }),
    Line: resolvedLines.map((line) => ({
      Amount: line.amount,
      DetailType: "AccountBasedExpenseLineDetail",
      ...(line.description && { Description: line.description }),
      AccountBasedExpenseLineDetail: {
        AccountRef: {
          value: line.account_id,
          name: line.account_name,
        },
        // A CustomerRef with no BillableStatus can default to Billable, which
        // would queue the cost for re-invoicing. These tools attribute cost;
        // they do not bill it, so say NotBillable explicitly.
        ...(line.customer_ref && {
          CustomerRef: line.customer_ref,
          BillableStatus: "NotBillable",
        }),
      },
    })),
  };

  if (draft) {
    const formatAccount = (l: typeof resolvedLines[0]) => {
      const num = l.account_num ? `${l.account_num} ` : "";
      return `${num}${l.account_name || l.account_id}`;
    };

    const preview = [
      "DRAFT - Expense Preview",
      "",
      `Payment Type: ${payment_type}`,
      `Payment Account: ${paymentAcct.acctNum ? `${paymentAcct.acctNum} ` : ""}${paymentAcct.name}`,
      `Payee: ${entityRef ? `${entityRef.name} (${entityRef.type})` : "(none)"}`,
      `Date: ${txn_date}`,
      `Ref no.: ${doc_number || "(auto-assign)"}`,
      `Department: ${departmentRef?.name || "(none)"}`,
      `Memo: ${memo || "(none)"}`,
      `Total: $${formatDollars(totalCents)}`,
      "",
      "Lines:",
      ...resolvedLines.map(l =>
        `  ${formatAccount(l)}: $${l.amount.toFixed(2)}${l.customer_ref ? ` [Customer: ${l.customer_ref.name}]` : ""}${l.description ? ` "${l.description}"` : ""}`
      ),
      "",
      "Set draft=false to create this expense.",
    ].join("\n");

    return {
      content: [{ type: "text", text: preview }],
    };
  }

  // Create the expense
  const result = await promisifyWrite<unknown>((cb) =>
    client.createPurchase(purchaseObject, cb)
  ) as { Id: string; DocNumber?: string };

  const qboUrl = buildQboUrl("expense", "txnId", result.Id);

  const response = [
    "Expense Created!",
    "",
    `Payment Type: ${payment_type}`,
    `Payment Account: ${paymentAcct.name}`,
    `Payee: ${entityRef?.name || "(none)"}`,
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

export async function handleGetExpense(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const expense = await promisify<unknown>((cb) =>
    client.getPurchase(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    PaymentType: string;
    DocNumber?: string;
    PrivateNote?: string;
    TotalAmt?: number;
    AccountRef?: { value: string; name?: string };
    EntityRef?: { value: string; name?: string; type?: string };
    DepartmentRef?: { value: string; name?: string };
    Line?: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      AccountBasedExpenseLineDetail?: {
        AccountRef: { value: string; name?: string };
        DepartmentRef?: { value: string; name?: string };
        CustomerRef?: { value: string; name?: string };
        BillableStatus?: string;
      };
      ItemBasedExpenseLineDetail?: {
        ItemRef: { value: string; name?: string };
        Qty?: number;
        UnitPrice?: number;
        CustomerRef?: { value: string; name?: string };
      };
    }>;
  };
  const qboUrl = buildQboUrl("expense", "txnId", expense.Id);

  // Format summary
  const lines: string[] = [
    'Expense (Purchase)',
    '==================',
    `ID: ${expense.Id}`,
    `SyncToken: ${expense.SyncToken}`,
    `Payment Type: ${expense.PaymentType}`,
    `Payment Account: ${expense.AccountRef?.name || expense.AccountRef?.value || '(none)'}`,
    `Payee: ${expense.EntityRef?.name || expense.EntityRef?.value || '(none)'}${expense.EntityRef?.type ? ` (${expense.EntityRef.type})` : ''}`,
    `Department: ${expense.DepartmentRef?.name || expense.DepartmentRef?.value || '(none)'}`,
    `Date: ${expense.TxnDate}`,
    `Ref no.: ${expense.DocNumber || '(none)'}`,
    `Memo: ${expense.PrivateNote || '(none)'}`,
    `Total: $${(expense.TotalAmt || 0).toFixed(2)}`,
    '',
    'Lines:',
  ];

  for (const line of expense.Line || []) {
    if (line.AccountBasedExpenseLineDetail) {
      const detail = line.AccountBasedExpenseLineDetail;
      const acctName = detail.AccountRef.name || detail.AccountRef.value;
      const deptStr = detail.DepartmentRef?.name ? ` [${detail.DepartmentRef.name}]` : '';
      const custStr = detail.CustomerRef?.name ? ` [Customer: ${detail.CustomerRef.name}]` : '';
      const descStr = line.Description ? ` "${line.Description}"` : '';
      lines.push(`  Line ${line.Id}: ${acctName}${deptStr}${custStr} $${line.Amount.toFixed(2)}${descStr}`);
    } else if (line.ItemBasedExpenseLineDetail) {
      const detail = line.ItemBasedExpenseLineDetail;
      const itemName = detail.ItemRef.name || detail.ItemRef.value;
      const descStr = line.Description ? ` "${line.Description}"` : '';
      lines.push(`  Line ${line.Id}: Item: ${itemName} (Qty: ${detail.Qty || 1}) $${line.Amount.toFixed(2)}${descStr}`);
    }
  }

  lines.push('');
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`expense-${expense.Id}`, expense, lines.join('\n'));
}

export async function handleEditExpense(
  client: QuickBooks,
  args: {
    id: string;
    txn_date?: string;
    memo?: string;
    payment_account?: string;
    department_name?: string;
    entity_name?: string;
    entity_id?: string;
    entity_type?: string;
    lines?: ExpenseLineChange[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id, txn_date, memo, payment_account, department_name, entity_name, entity_id, entity_type, lines: lineChanges, draft = true } = args;

  // Fetch current Purchase
  const current = await promisify<unknown>((cb) =>
    client.getPurchase(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    PaymentType: string;
    DocNumber?: string;
    PrivateNote?: string;
    AccountRef?: { value: string; name?: string };
    EntityRef?: { value: string; name?: string; type?: string };
    DepartmentRef?: { value: string; name?: string };
    Line: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      AccountBasedExpenseLineDetail?: {
        AccountRef: { value: string; name?: string };
        DepartmentRef?: { value: string; name?: string };
        CustomerRef?: { value: string; name?: string };
        BillableStatus?: string;
      };
    }>;
  };

  // Determine whether the Line array has to be rebuilt for this edit
  const needsLineRebuild = lineChanges && lineChanges.length > 0;

  // Build updated Purchase
  // Note: PaymentType is required by QB API even for sparse updates
  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    PaymentType: current.PaymentType,
  };

  // Always sparse. A full update nulls every writable field absent from the
  // payload — it previously stripped DepartmentRef/EntityRef, and it still
  // clears Credit, which flips a card refund into a charge. Sparse also handles
  // line changes, including deletion, provided the complete Line array is sent.
  // See docs/quickbooks-api-limitations.md.
  updated.sparse = true;

  if (needsLineRebuild) {
    // Seed with the existing lines, stripping read-only fields
    updated.Line = current.Line.map(line => {
      const { LineNum, ...rest } = line as Record<string, unknown>;
      return rest;
    });
  }

  if (txn_date !== undefined) updated.TxnDate = txn_date;
  if (memo !== undefined) updated.PrivateNote = memo;

  // Resolve payment account if provided
  if (payment_account !== undefined) {
    const acctCache = await getAccountCache(client);
    updated.AccountRef = toQboRef(
      resolveAccountRef(acctCache, payment_account, { label: "Payment account" })
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

  // Resolve the payee if provided. entity_type picks the name list (Vendor,
  // Customer, or Employee) and defaults to Vendor.
  const entityInput = entity_id || entity_name;
  if (entityInput) {
    updated.EntityRef = toPurchaseEntityRef(
      await resolveEntityRef(client, entityInput, normalizeEntityKind(entity_type))
    );
  }

  // Process line changes if provided
  // Use updated.Line if available (for full updates with stripped read-only fields), else current.Line
  let finalLines = [...((updated.Line as typeof current.Line) || current.Line)];

  if (lineChanges && lineChanges.length > 0) {
    const acctCache = await getAccountCache(client);

    const resolveAcct = (name: string) => toQboRef(resolveAccountRef(acctCache, name));

    for (const change of lineChanges) {
      if (change.line_id) {
        const lineIndex = finalLines.findIndex(l => l.Id === change.line_id);
        if (lineIndex === -1) {
          throw new Error(`Line ID ${change.line_id} not found in expense`);
        }

        if (change.delete) {
          finalLines.splice(lineIndex, 1);
        } else {
          const line = { ...finalLines[lineIndex] };
          const detail = { ...(line.AccountBasedExpenseLineDetail || {}) } as {
            AccountRef: { value: string; name?: string };
            DepartmentRef?: { value: string; name?: string };
            CustomerRef?: { value: string; name?: string };
            BillableStatus?: string;
          };

          if (change.amount !== undefined) {
            const amountCents = validateAmount(change.amount, `Line ${change.line_id}`);
            line.Amount = toDollars(amountCents);
          }
          if (change.description !== undefined) line.Description = change.description;
          if (change.account_name !== undefined) detail.AccountRef = resolveAcct(change.account_name);

          // Spreading the existing detail already preserves CustomerRef; only an
          // explicit customer input changes it, and an empty one clears it.
          const customerRef = await resolveCustomerInput(client, change, `Line ${change.line_id}`);
          if (customerRef === null) {
            delete detail.CustomerRef;
          } else if (customerRef) {
            detail.CustomerRef = customerRef;
            detail.BillableStatus = detail.BillableStatus ?? "NotBillable";
          }

          line.AccountBasedExpenseLineDetail = detail;
          line.DetailType = 'AccountBasedExpenseLineDetail';
          finalLines[lineIndex] = line;
        }
      } else {
        if (!change.amount || !change.account_name) {
          throw new Error('New lines require amount and account_name');
        }

        // Validate and normalize the amount
        const amountCents = validateAmount(change.amount, `New line for ${change.account_name}`);

        const newCustomer = await resolveCustomerInput(
          client,
          change,
          `New line for ${change.account_name}`
        );

        // Id omitted for new lines - QB will assign
        const newLine = {
          Amount: toDollars(amountCents),
          Description: change.description,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: resolveAcct(change.account_name),
            ...(newCustomer && {
              CustomerRef: newCustomer,
              BillableStatus: "NotBillable",
            }),
          }
        } as typeof finalLines[0];
        finalLines.push(newLine);
      }
    }

    updated.Line = finalLines;
  }

  const qboUrl = buildQboUrl("expense", "txnId", id);

  if (draft) {
    const previewLines: string[] = [
      'DRAFT - Expense Edit Preview',
      '',
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      `Payment Type: ${current.PaymentType} (cannot be changed)`,
      '',
      'Changes:',
    ];

    if (txn_date !== undefined) previewLines.push(`  Date: ${current.TxnDate} → ${txn_date}`);
    if (memo !== undefined) previewLines.push(`  Memo: ${current.PrivateNote || '(none)'} → ${memo}`);
    if (payment_account !== undefined) {
      const newAcct = (updated.AccountRef as { name?: string })?.name || payment_account;
      previewLines.push(`  Payment Account: ${current.AccountRef?.name || '(none)'} → ${newAcct}`);
    }
    if (department_name !== undefined) {
      const newDept = (updated.DepartmentRef as { name?: string })?.name || department_name;
      previewLines.push(`  Department: ${current.DepartmentRef?.name || '(none)'} → ${newDept}`);
    }
    if (entityInput) {
      const ref = updated.EntityRef as { name?: string; type?: string } | undefined;
      const newEntity = ref?.name ? `${ref.name} (${ref.type})` : entityInput;
      previewLines.push(`  Payee: ${current.EntityRef?.name || '(none)'} → ${newEntity}`);
    }

    if (updated.Line) {
      previewLines.push('');
      previewLines.push('Updated Lines:');
      for (const line of updated.Line as typeof finalLines) {
        const detail = line.AccountBasedExpenseLineDetail;
        if (detail) {
          const acctName = detail.AccountRef.name || detail.AccountRef.value;
          const deptStr = detail.DepartmentRef?.name ? ` [${detail.DepartmentRef.name}]` : '';
          const custStr = detail.CustomerRef?.name ? ` [Customer: ${detail.CustomerRef.name}]` : '';
          previewLines.push(`  ${acctName}${deptStr}${custStr}: $${line.Amount.toFixed(2)}`);
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
    client.updatePurchase(updated, cb)
  ) as { Id: string; SyncToken: string };

  return {
    content: [{ type: "text", text: `Expense ${id} updated successfully.\nNew SyncToken: ${result.SyncToken}\nView in QuickBooks: ${qboUrl}` }],
  };
}
