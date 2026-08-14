// Handlers for vendor credit tools (create, get, edit)

import QuickBooks from "node-quickbooks";
import {
  promisify,
  getAccountCache,
  getDepartmentCache,
  getVendorCache,
  resolveAccountRef,
  resolveVendorRef,
  toQboRef,
} from "../../client/index.js";
import { buildQboUrl, validateAmount, toDollars, formatDollars, sumCents, outputReport } from "../../utils/index.js";

interface CreateVendorCreditLine {
  account_id?: string;
  account_name?: string;
  amount: number;
  description?: string;
}

interface VendorCreditLineChange {
  line_id?: string;
  account_name?: string;
  amount?: number;
  description?: string;
  delete?: boolean;
}

export async function handleCreateVendorCredit(
  client: QuickBooks,
  args: {
    vendor_name?: string;
    vendor_id?: string;
    txn_date: string;
    department_name?: string;
    department_id?: string;
    ap_account?: string;
    memo?: string;
    doc_number?: string;
    lines: CreateVendorCreditLine[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    vendor_name, vendor_id, txn_date,
    department_name, department_id, ap_account,
    memo, doc_number, lines, draft = true,
  } = args;

  if (!lines || lines.length === 0) {
    throw new Error("At least one line is required");
  }

  // Get cached lookups
  const [acctCache, deptCache, vendorCacheData] = await Promise.all([
    getAccountCache(client),
    getDepartmentCache(client),
    getVendorCache(client),
  ]);

  // Resolve vendor
  let vendorRef: { value: string; name: string };
  if (vendor_id) {
    vendorRef = resolveVendorRef(vendorCacheData, vendor_id);
  } else if (vendor_name) {
    vendorRef = resolveVendorRef(vendorCacheData, vendor_name);
  } else {
    throw new Error("Either vendor_name or vendor_id is required");
  }

  // Resolve department (header-level)
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

  // Resolve AP account if specified
  let apAccountRef: { value: string; name: string } | undefined;
  if (ap_account) {
    // Same A/P restriction as create_bill — the field feeds the same QBO ref.
    const acct = resolveAccountRef(acctCache, ap_account, {
      label: "A/P account",
      accountType: "Accounts Payable",
    });
    apAccountRef = { value: acct.value, name: acct.name };
  }

  // Resolve lines
  const resolvedLines = lines.map((line) => {
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

    return {
      ...line,
      account_id: accountId!,
      account_name: accountName,
      account_num: accountNum,
      amount_cents: amountCents,
      amount: toDollars(amountCents),
    };
  });

  // Calculate total
  const totalCents = sumCents(resolvedLines.map(l => l.amount_cents));

  // Build QuickBooks VendorCredit object
  const vcObject: Record<string, unknown> = {
    VendorRef: vendorRef,
    TxnDate: txn_date,
    ...(memo && { PrivateNote: memo }),
    ...(doc_number && { DocNumber: doc_number }),
    ...(departmentRef && { DepartmentRef: departmentRef }),
    ...(apAccountRef && { APAccountRef: apAccountRef }),
    Line: resolvedLines.map((line) => ({
      Amount: line.amount,
      DetailType: "AccountBasedExpenseLineDetail",
      ...(line.description && { Description: line.description }),
      AccountBasedExpenseLineDetail: {
        AccountRef: {
          value: line.account_id,
          name: line.account_name,
        },
        BillableStatus: "NotBillable",
      },
    })),
  };

  if (draft) {
    const formatAccount = (l: typeof resolvedLines[0]) => {
      const num = l.account_num ? `${l.account_num} ` : "";
      return `${num}${l.account_name || l.account_id}`;
    };

    const preview = [
      "DRAFT - Vendor Credit Preview",
      "",
      `Vendor: ${vendorRef.name}`,
      `Date: ${txn_date}`,
      `Ref no.: ${doc_number || "(auto-assign)"}`,
      `Department: ${departmentRef?.name || "(none)"}`,
      `AP Account: ${apAccountRef?.name || "(default)"}`,
      `Memo: ${memo || "(none)"}`,
      `Total: $${formatDollars(totalCents)}`,
      "",
      "Lines:",
      ...resolvedLines.map(l =>
        `  ${formatAccount(l)}: $${l.amount.toFixed(2)}${l.description ? ` "${l.description}"` : ""}`
      ),
      "",
      "Set draft=false to create this vendor credit.",
    ].join("\n");

    return {
      content: [{ type: "text", text: preview }],
    };
  }

  // Create the vendor credit
  const result = await promisify<unknown>((cb) =>
    client.createVendorCredit(vcObject, cb)
  ) as { Id: string; DocNumber?: string };

  const qboUrl = buildQboUrl("vendorcredit", "txnId", result.Id);

  const response = [
    "Vendor Credit Created!",
    "",
    `Vendor: ${vendorRef.name}`,
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

export async function handleGetVendorCredit(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const vc = await promisify<unknown>((cb) =>
    client.getVendorCredit(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DocNumber?: string;
    PrivateNote?: string;
    TotalAmt?: number;
    VendorRef?: { value: string; name?: string };
    APAccountRef?: { value: string; name?: string };
    DepartmentRef?: { value: string; name?: string };
    Line?: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      AccountBasedExpenseLineDetail?: {
        AccountRef: { value: string; name?: string };
        DepartmentRef?: { value: string; name?: string };
      };
    }>;
  };
  const qboUrl = buildQboUrl("vendorcredit", "txnId", vc.Id);

  // Format summary
  const lines: string[] = [
    'Vendor Credit',
    '=============',
    `ID: ${vc.Id}`,
    `SyncToken: ${vc.SyncToken}`,
    `Vendor: ${vc.VendorRef?.name || vc.VendorRef?.value || '(none)'}`,
    `Date: ${vc.TxnDate}`,
    `Ref no.: ${vc.DocNumber || '(none)'}`,
    `Memo: ${vc.PrivateNote || '(none)'}`,
    `AP Account: ${vc.APAccountRef?.name || vc.APAccountRef?.value || 'Accounts Payable'}`,
    `Department: ${vc.DepartmentRef?.name || vc.DepartmentRef?.value || '(none)'}`,
    `Total: $${(vc.TotalAmt || 0).toFixed(2)}`,
    '',
    'Lines:',
  ];

  for (const line of vc.Line || []) {
    if (line.AccountBasedExpenseLineDetail) {
      const detail = line.AccountBasedExpenseLineDetail;
      const acctName = detail.AccountRef.name || detail.AccountRef.value;
      const deptStr = detail.DepartmentRef?.name ? ` [${detail.DepartmentRef.name}]` : '';
      const descStr = line.Description ? ` "${line.Description}"` : '';
      lines.push(`  Line ${line.Id}: ${acctName}${deptStr} $${line.Amount.toFixed(2)}${descStr}`);
    }
  }

  lines.push('');
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`vendor-credit-${vc.Id}`, vc, lines.join('\n'));
}

export async function handleEditVendorCredit(
  client: QuickBooks,
  args: {
    id: string;
    vendor_name?: string;
    txn_date?: string;
    memo?: string;
    doc_number?: string;
    lines?: VendorCreditLineChange[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id, vendor_name, txn_date, memo, doc_number, lines: lineChanges, draft = true } = args;

  // Fetch current VendorCredit
  const current = await promisify<unknown>((cb) =>
    client.getVendorCredit(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DocNumber?: string;
    PrivateNote?: string;
    VendorRef: { value: string; name?: string };
    DepartmentRef?: { value: string; name?: string };
    Line: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      AccountBasedExpenseLineDetail?: {
        AccountRef: { value: string; name?: string };
        DepartmentRef?: { value: string; name?: string };
      };
    }>;
  };

  // Determine if we're modifying lines - requires full update (not sparse)
  const needsLineRebuild = lineChanges && lineChanges.length > 0;

  // Build updated VendorCredit
  // Note: VendorRef is required by QB API even for sparse updates
  let vendorRef = current.VendorRef;

  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
    VendorRef: vendorRef,
  };

  // Always sparse. A full update nulls every writable field absent from the
  // payload. Sparse also handles line changes, including deletion, provided the
  // complete Line array is sent. See docs/quickbooks-api-limitations.md.
  updated.sparse = true;

  if (needsLineRebuild) {
    // Seed with the existing lines, stripping read-only fields
    updated.Line = current.Line.map(line => {
      const { LineNum, ...rest } = line as Record<string, unknown>;
      return rest;
    });
  }

  // Resolve vendor if changing
  if (vendor_name) {
    const vendorCacheData = await getVendorCache(client);
    vendorRef = resolveVendorRef(vendorCacheData, vendor_name);
    updated.VendorRef = vendorRef;
  }

  if (txn_date !== undefined) updated.TxnDate = txn_date;
  if (memo !== undefined) updated.PrivateNote = memo;
  if (doc_number !== undefined) updated.DocNumber = doc_number;

  // Process line changes if provided
  let finalLines = [...((updated.Line as typeof current.Line) || current.Line)];

  if (lineChanges && lineChanges.length > 0) {
    const acctCache = await getAccountCache(client);

    const resolveAcct = (name: string) => toQboRef(resolveAccountRef(acctCache, name));

    for (const change of lineChanges) {
      if (change.line_id) {
        const lineIndex = finalLines.findIndex(l => l.Id === change.line_id);
        if (lineIndex === -1) {
          throw new Error(`Line ID ${change.line_id} not found in vendor credit`);
        }

        if (change.delete) {
          finalLines.splice(lineIndex, 1);
        } else {
          const line = { ...finalLines[lineIndex] };
          const detail = { ...(line.AccountBasedExpenseLineDetail || {}) } as {
            AccountRef: { value: string; name?: string };
            DepartmentRef?: { value: string; name?: string };
          };

          if (change.amount !== undefined) {
            const amountCents = validateAmount(change.amount, `Line ${change.line_id}`);
            line.Amount = toDollars(amountCents);
          }
          if (change.description !== undefined) line.Description = change.description;
          if (change.account_name !== undefined) detail.AccountRef = resolveAcct(change.account_name);

          line.AccountBasedExpenseLineDetail = detail;
          line.DetailType = 'AccountBasedExpenseLineDetail';
          finalLines[lineIndex] = line;
        }
      } else {
        if (!change.amount || !change.account_name) {
          throw new Error('New lines require amount and account_name');
        }

        const amountCents = validateAmount(change.amount, `New line for ${change.account_name}`);

        const newLine = {
          Amount: toDollars(amountCents),
          Description: change.description,
          DetailType: 'AccountBasedExpenseLineDetail',
          AccountBasedExpenseLineDetail: {
            AccountRef: resolveAcct(change.account_name),
          }
        } as typeof finalLines[0];
        finalLines.push(newLine);
      }
    }

    updated.Line = finalLines;
  }

  const qboUrl = buildQboUrl("vendorcredit", "txnId", id);

  if (draft) {
    const previewLines: string[] = [
      'DRAFT - Vendor Credit Edit Preview',
      '',
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      '',
      'Changes:',
    ];

    if (vendor_name) previewLines.push(`  Vendor: ${current.VendorRef?.name || current.VendorRef?.value} → ${(vendorRef as { name?: string }).name || vendor_name}`);
    if (txn_date !== undefined) previewLines.push(`  Date: ${current.TxnDate} → ${txn_date}`);
    if (memo !== undefined) previewLines.push(`  Memo: ${current.PrivateNote || '(none)'} → ${memo}`);
    if (doc_number !== undefined) previewLines.push(`  Ref no.: ${current.DocNumber || '(none)'} → ${doc_number}`);

    if (updated.Line) {
      previewLines.push('');
      previewLines.push('Updated Lines:');
      for (const line of updated.Line as typeof finalLines) {
        const detail = line.AccountBasedExpenseLineDetail;
        if (detail) {
          const acctName = detail.AccountRef.name || detail.AccountRef.value;
          const deptStr = detail.DepartmentRef?.name ? ` [${detail.DepartmentRef.name}]` : '';
          previewLines.push(`  ${acctName}${deptStr}: $${line.Amount.toFixed(2)}`);
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
    client.updateVendorCredit(updated, cb)
  ) as { Id: string; SyncToken: string };

  return {
    content: [{ type: "text", text: `Vendor Credit ${id} updated successfully.\nNew SyncToken: ${result.SyncToken}\nView in QuickBooks: ${qboUrl}` }],
  };
}
