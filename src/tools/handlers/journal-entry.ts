// Handlers for journal entry tools (create, get, edit)

import QuickBooks from "node-quickbooks";
import {
  promisify,
  getAccountCache,
  getDepartmentCache,
} from "../../client/index.js";
import {
  buildQboUrl,
  validateAmount,
  sumCents,
  validateBalance,
  toDollars,
  formatDollars,
  outputReport,
} from "../../utils/index.js";

interface JournalEntryLine {
  account_id?: string;
  account_name?: string;
  amount: number;
  posting_type: "Debit" | "Credit";
  department_id?: string;
  department_name?: string;
  description?: string;
}

interface JournalEntryLineChange {
  line_id?: string;
  account_name?: string;
  amount?: number;
  posting_type?: "Debit" | "Credit";
  department_name?: string;
  description?: string;
  delete?: boolean;
}

export async function handleCreateJournalEntry(
  client: QuickBooks,
  args: {
    txn_date: string;
    memo?: string;
    lines: JournalEntryLine[];
    draft?: boolean;
    doc_number?: string;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { txn_date, memo, lines: rawLines, draft = true, doc_number } = args;

  // Defensive: MCP transports may deliver arrays as JSON strings
  const lines: JournalEntryLine[] = typeof rawLines === "string" ? JSON.parse(rawLines) : rawLines;

  // Get cached accounts and departments (uses TTL-based cache)
  const [acctCache, deptCache] = await Promise.all([
    getAccountCache(client),
    getDepartmentCache(client)
  ]);

  // Helper to lookup account by name or AcctNum from cache
  const lookupAccount = (name: string): { id: string; name: string; acctNum?: string } => {
    // Try exact AcctNum match (case-insensitive)
    let match = acctCache.byAcctNum.get(name.toLowerCase());

    // Try exact name match (case-insensitive)
    if (!match) {
      match = acctCache.byName.get(name.toLowerCase());
    }

    // Try partial match on FullyQualifiedName
    if (!match) {
      match = acctCache.items.find(a =>
        a.FullyQualifiedName?.toLowerCase().includes(name.toLowerCase()) ||
        a.FullyQualifiedName?.toLowerCase() === name.toLowerCase()
      );
    }

    if (match) {
      return { id: match.Id, name: match.FullyQualifiedName || match.Name, acctNum: match.AcctNum };
    }
    throw new Error(`Account not found: "${name}"`);
  };

  // Helper to lookup department by name from cache
  const lookupDepartment = (name: string): { id: string; name: string } => {
    // Try exact name match (case-insensitive)
    let match = deptCache.byName.get(name.toLowerCase());

    // Try partial match on FullyQualifiedName
    if (!match) {
      match = deptCache.items.find(d =>
        d.FullyQualifiedName?.toLowerCase().includes(name.toLowerCase())
      );
    }

    if (match) {
      return { id: match.Id, name: match.FullyQualifiedName || match.Name };
    }
    throw new Error(`Department not found: "${name}"`);
  };

  // Resolve account and department names to IDs (all lookups are from cache)
  const resolvedLines = lines.map((line) => {
    let accountId = line.account_id;
    let accountName = line.account_name;
    let accountNum: string | undefined;
    let departmentId = line.department_id;
    let departmentName = line.department_name;

    // Resolve account
    if (!accountId && accountName) {
      const account = lookupAccount(accountName);
      accountId = account.id;
      accountName = account.name;
      accountNum = account.acctNum;
    } else if (!accountId && !accountName) {
      throw new Error("Each line must have either account_id or account_name");
    }

    // Resolve department
    if (!departmentId && departmentName) {
      const dept = lookupDepartment(departmentName);
      departmentId = dept.id;
      departmentName = dept.name;
    }

    // Validate and convert amount to cents
    const amountCents = validateAmount(line.amount, `Line ${accountName || accountId}`);

    return {
      ...line,
      account_id: accountId!,
      account_name: accountName,
      account_num: accountNum,
      department_id: departmentId,
      department_name: departmentName,
      amount_cents: amountCents,
      // Normalize amount to exactly 2 decimal places
      amount: toDollars(amountCents)
    };
  });

  // Validate debits = credits using cents (exact integer comparison)
  const totalDebitsCents = sumCents(
    resolvedLines.filter(l => l.posting_type === "Debit").map(l => l.amount_cents)
  );
  const totalCreditsCents = sumCents(
    resolvedLines.filter(l => l.posting_type === "Credit").map(l => l.amount_cents)
  );

  validateBalance(totalDebitsCents, totalCreditsCents);

  // Build QuickBooks JournalEntry object
  const journalEntry: Record<string, unknown> = {
    TxnDate: txn_date,
    PrivateNote: memo,
    ...(doc_number && { DocNumber: doc_number }),
    Line: resolvedLines.map((line, idx) => ({
      Id: String(idx),
      Amount: line.amount,
      DetailType: "JournalEntryLineDetail",
      Description: line.description,
      JournalEntryLineDetail: {
        PostingType: line.posting_type,
        AccountRef: {
          value: line.account_id,
          name: line.account_name
        },
        ...(line.department_id && {
          DepartmentRef: {
            value: line.department_id
          }
        })
      }
    }))
  };

  if (draft) {
    // Preview mode - return what would be created
    const formatAccount = (l: typeof resolvedLines[0]) => {
      const num = l.account_num ? `${l.account_num} ` : "";
      return `${num}${l.account_name || l.account_id}`;
    };

    const preview = [
      "DRAFT - Journal Entry Preview",
      "",
      `Date: ${txn_date}`,
      `Journal no.: ${doc_number || "(auto-assign)"}`,
      `Memo: ${memo || "(none)"}`,
      `Total: $${formatDollars(totalDebitsCents)}`,
      "",
      "Lines:",
      ...resolvedLines.map(l =>
        `  ${l.posting_type.padEnd(6)} ${formatAccount(l)}${l.department_id ? ` [Dept: ${l.department_name || l.department_id}]` : ""}: $${l.amount.toFixed(2)}`
      ),
      "",
      doc_number
        ? "Set draft=false to create this entry."
        : "Set draft=false to create this entry, or specify doc_number to set the journal number."
    ].join("\n");

    return {
      content: [{ type: "text", text: preview }],
    };
  }

  // Create the entry
  const result = await promisify<unknown>((cb) =>
    client.createJournalEntry(journalEntry, cb)
  ) as { Id: string; DocNumber?: string };

  // Build QuickBooks URL
  const qboUrl = buildQboUrl("journal", "txnId", result.Id);

  const response = [
    "Journal Entry Created!",
    "",
    `Journal no.: ${result.DocNumber || "(auto-assigned)"}`,
    `Date: ${txn_date}`,
    `Total: $${formatDollars(totalDebitsCents)}`,
    "",
    `View in QuickBooks: ${qboUrl}`
  ].join("\n");

  return {
    content: [{ type: "text", text: response }],
  };
}

export async function handleGetJournalEntry(
  client: QuickBooks,
  args: { id: string }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id } = args;

  const je = await promisify<unknown>((cb) =>
    client.getJournalEntry(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DocNumber?: string;
    PrivateNote?: string;
    TotalAmt?: number;
    Line?: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      JournalEntryLineDetail?: {
        PostingType: string;
        AccountRef: { value: string; name?: string };
        DepartmentRef?: { value: string; name?: string };
      };
    }>;
  };
  const qboUrl = buildQboUrl("journal", "txnId", je.Id);

  // Format summary
  const lines: string[] = [
    'Journal Entry',
    '=============',
    `ID: ${je.Id}`,
    `SyncToken: ${je.SyncToken}`,
    `Date: ${je.TxnDate}`,
    `Journal no.: ${je.DocNumber || '(none)'}`,
    `Memo: ${je.PrivateNote || '(none)'}`,
    `Total: $${(je.TotalAmt || 0).toFixed(2)}`,
    '',
    'Lines:',
  ];

  for (const line of je.Line || []) {
    const detail = line.JournalEntryLineDetail;
    if (!detail) continue;
    const acctName = detail.AccountRef.name || detail.AccountRef.value;
    const deptName = detail.DepartmentRef?.name || detail.DepartmentRef?.value;
    const deptStr = deptName ? ` [${deptName}]` : '';
    const descStr = line.Description ? ` "${line.Description}"` : '';
    lines.push(`  Line ${line.Id}: ${detail.PostingType.padEnd(6)} ${acctName}${deptStr} $${line.Amount.toFixed(2)}${descStr}`);
  }

  lines.push('');
  lines.push(`View in QuickBooks: ${qboUrl}`);

  return outputReport(`journal-entry-${je.Id}`, je, lines.join('\n'));
}

export async function handleEditJournalEntry(
  client: QuickBooks,
  args: {
    id: string;
    txn_date?: string;
    memo?: string;
    doc_number?: string;
    lines?: JournalEntryLineChange[];
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { id, txn_date, memo, doc_number, lines: rawLineChanges, draft = true } = args;

  // Defensive: MCP transports may deliver arrays as JSON strings
  const lineChanges: JournalEntryLineChange[] | undefined =
    typeof rawLineChanges === "string" ? JSON.parse(rawLineChanges) : rawLineChanges;

  // Fetch current JE
  const current = await promisify<unknown>((cb) =>
    client.getJournalEntry(id, cb)
  ) as {
    Id: string;
    SyncToken: string;
    TxnDate: string;
    DocNumber?: string;
    PrivateNote?: string;
    Line: Array<{
      Id: string;
      Amount: number;
      Description?: string;
      DetailType: string;
      JournalEntryLineDetail: {
        PostingType: string;
        AccountRef: { value: string; name?: string };
        DepartmentRef?: { value: string; name?: string };
      };
    }>;
  };

  // Determine whether the Line array has to be rebuilt for this edit
  const needsLineRebuild = lineChanges && lineChanges.length > 0;

  // Build updated JE
  const updated: Record<string, unknown> = {
    Id: current.Id,
    SyncToken: current.SyncToken,
  };

  // Always sparse. A full update nulls every writable field absent from the
  // payload (Adjustment here). Sparse also handles line changes, including
  // deletion, provided the complete Line array is sent.
  // See docs/quickbooks-api-limitations.md.
  updated.sparse = true;

  if (needsLineRebuild) {
    // Seed with the existing lines, stripping read-only fields
    updated.Line = current.Line.map(line => {
      const { LineNum, ...rest } = line as Record<string, unknown>;
      return rest;
    });
  }

  // Update simple fields if provided
  if (txn_date !== undefined) updated.TxnDate = txn_date;
  if (memo !== undefined) updated.PrivateNote = memo;
  if (doc_number !== undefined) updated.DocNumber = doc_number;

  // Process line changes if provided
  // Use updated.Line if available (for full updates with stripped read-only fields), else current.Line
  let finalLines = [...((updated.Line as typeof current.Line) || current.Line)];

  if (lineChanges && lineChanges.length > 0) {
    // Get caches for lookups
    const [acctCache, deptCache] = await Promise.all([
      getAccountCache(client),
      getDepartmentCache(client)
    ]);

    // Helper to resolve account
    const resolveAcct = (name: string) => {
      let match = acctCache.byAcctNum.get(name.toLowerCase());
      if (!match) match = acctCache.byName.get(name.toLowerCase());
      if (!match) match = acctCache.items.find(a =>
        a.FullyQualifiedName?.toLowerCase().includes(name.toLowerCase())
      );
      if (!match) throw new Error(`Account not found: "${name}"`);
      return { value: match.Id, name: match.FullyQualifiedName || match.Name };
    };

    // Helper to resolve department
    const resolveDept = (name: string) => {
      let match = deptCache.byName.get(name.toLowerCase());
      if (!match) match = deptCache.items.find(d =>
        d.FullyQualifiedName?.toLowerCase().includes(name.toLowerCase())
      );
      if (!match) throw new Error(`Department not found: "${name}"`);
      return { value: match.Id, name: match.FullyQualifiedName || match.Name };
    };

    for (const change of lineChanges) {
      if (change.line_id) {
        // Find existing line
        const lineIndex = finalLines.findIndex(l => l.Id === change.line_id);
        if (lineIndex === -1) {
          throw new Error(`Line ID ${change.line_id} not found in journal entry`);
        }

        if (change.delete) {
          // Remove the line
          finalLines.splice(lineIndex, 1);
        } else {
          // Update existing line
          const line = { ...finalLines[lineIndex] };
          const detail = { ...line.JournalEntryLineDetail };

          if (change.amount !== undefined) {
            // Validate and normalize the amount
            const amountCents = validateAmount(change.amount, `Line ${change.line_id}`);
            line.Amount = toDollars(amountCents);
          }
          if (change.description !== undefined) line.Description = change.description;
          if (change.posting_type !== undefined) detail.PostingType = change.posting_type;
          if (change.account_name !== undefined) detail.AccountRef = resolveAcct(change.account_name);
          if (change.department_name !== undefined) detail.DepartmentRef = resolveDept(change.department_name);

          line.JournalEntryLineDetail = detail;
          finalLines[lineIndex] = line;
        }
      } else {
        // New line
        if (!change.amount || !change.posting_type || !change.account_name) {
          throw new Error('New lines require amount, posting_type, and account_name');
        }

        // Validate and normalize the amount
        const amountCents = validateAmount(change.amount, `New line for ${change.account_name}`);

        // Id omitted for new lines - QB will assign
        const newLine = {
          Amount: toDollars(amountCents),
          Description: change.description,
          DetailType: 'JournalEntryLineDetail',
          JournalEntryLineDetail: {
            PostingType: change.posting_type,
            AccountRef: resolveAcct(change.account_name),
            ...(change.department_name && { DepartmentRef: resolveDept(change.department_name) })
          }
        } as typeof finalLines[0];
        finalLines.push(newLine);
      }
    }

    updated.Line = finalLines;
  }

  // Validate debits = credits if lines were modified (using cents for exact comparison)
  if (updated.Line) {
    const lines = updated.Line as typeof finalLines;
    const totalDebitsCents = sumCents(
      lines.filter(l => l.JournalEntryLineDetail.PostingType === 'Debit').map(l => validateAmount(l.Amount))
    );
    const totalCreditsCents = sumCents(
      lines.filter(l => l.JournalEntryLineDetail.PostingType === 'Credit').map(l => validateAmount(l.Amount))
    );

    validateBalance(totalDebitsCents, totalCreditsCents);
  }

  const qboUrl = buildQboUrl("journal", "txnId", id);

  if (draft) {
    // Preview mode
    const previewLines: string[] = [
      'DRAFT - Journal Entry Edit Preview',
      '',
      `ID: ${id}`,
      `SyncToken: ${current.SyncToken}`,
      '',
      'Changes:',
    ];

    if (txn_date !== undefined) previewLines.push(`  Date: ${current.TxnDate} → ${txn_date}`);
    if (memo !== undefined) previewLines.push(`  Memo: ${current.PrivateNote || '(none)'} → ${memo}`);
    if (doc_number !== undefined) previewLines.push(`  Journal no.: ${current.DocNumber || '(none)'} → ${doc_number}`);

    if (updated.Line) {
      previewLines.push('');
      previewLines.push('Updated Lines:');
      for (const line of updated.Line as typeof finalLines) {
        const detail = line.JournalEntryLineDetail;
        const acctName = detail.AccountRef.name || detail.AccountRef.value;
        const deptStr = detail.DepartmentRef?.name ? ` [${detail.DepartmentRef.name}]` : '';
        previewLines.push(`  ${detail.PostingType.padEnd(6)} ${acctName}${deptStr}: $${line.Amount.toFixed(2)}`);
      }
    }

    previewLines.push('');
    previewLines.push('Set draft=false to apply these changes.');

    return {
      content: [{ type: "text", text: previewLines.join('\n') }],
    };
  }

  // Apply the update
  const result = await promisify<unknown>((cb) =>
    client.updateJournalEntry(updated, cb)
  ) as { Id: string; SyncToken: string };

  return {
    content: [{ type: "text", text: `Journal Entry ${id} updated successfully.\nNew SyncToken: ${result.SyncToken}\nView in QuickBooks: ${qboUrl}` }],
  };
}
