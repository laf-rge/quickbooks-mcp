// Extract transaction lines that reference a specific account

import { TransactionLine, AccountCache } from "../types/index.js";
import { getQboUrl } from "../utils/index.js";

// Helper type for account reference
interface AccountRef {
  value?: string;
  name?: string;
}

// Get formatted account name from cache or fallback to ref name
function getAccountName(accountId: string, accountCache: AccountCache, refName?: string): string {
  const cached = accountCache.byId.get(accountId);
  if (cached) {
    return cached.AcctNum ? `${cached.AcctNum} ${cached.Name}` : cached.Name;
  }
  return refName || accountId;
}

// Extract ALL transaction lines from transactions that have ANY line matching the target account
// Returns lines with account info and flags for which lines matched the query
export function extractAccountLines(
  entities: Array<Record<string, unknown>>,
  entityType: string,
  targetAccountId: string,
  accountCache: AccountCache,
  departmentFilter?: string
): TransactionLine[] {
  const lines: TransactionLine[] = [];

  for (const entity of entities) {
    const txnId = entity.Id as string;
    const txnDate = entity.TxnDate as string;
    const docNumber = entity.DocNumber as string | undefined;
    const qboLink = getQboUrl(entityType, txnId) || '';

    // Helper to check if a line matches the department filter
    const matchesDepartment = (lineDetail: Record<string, unknown>): boolean => {
      if (!departmentFilter) return true;
      const deptRef = lineDetail.DepartmentRef as { value?: string } | undefined;
      return deptRef?.value === departmentFilter;
    };

    // Helper to get department name from line
    const getDepartment = (lineDetail: Record<string, unknown>): string | undefined => {
      const deptRef = lineDetail.DepartmentRef as { value?: string; name?: string } | undefined;
      return deptRef?.name || deptRef?.value;
    };

    // Extract all lines and check if any match the target account
    const extractedLines: TransactionLine[] = [];
    let hasMatchingLine = false;

    switch (entityType.toLowerCase()) {
      case 'journalentry': {
        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.JournalEntryLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          const accountRef = detail.AccountRef as AccountRef | undefined;
          const accountId = accountRef?.value || '';
          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          const postingType = detail.PostingType as string;
          const amount = line.Amount as number;
          // Debit = positive, Credit = negative
          const signedAmount = postingType === 'Debit' ? amount : -amount;

          extractedLines.push({
            date: txnDate,
            type: 'JournalEntry',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: signedAmount,
            description: line.Description as string | undefined,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, accountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'purchase': {
        // Header: AccountRef is the bank/credit card account being debited
        const headerAccountRef = entity.AccountRef as AccountRef | undefined;
        const headerAccountId = headerAccountRef?.value || '';
        const headerDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || headerDeptRef?.value === departmentFilter;

        if (headerAccountId && headerMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = headerAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Purchase',
            txnId,
            docNumber,
            lineId: 'header',
            amount: -totalAmt, // Credit to bank account
            description: entity.PrivateNote as string | undefined,
            department: headerDeptRef?.name,
            qboLink,
            accountId: headerAccountId,
            accountName: getAccountName(headerAccountId, accountCache, headerAccountRef?.name),
            isMatchingLine: isMatching
          });
        }

        // Lines: AccountBasedExpenseLineDetail for expense accounts
        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.AccountBasedExpenseLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          const accountRef = detail.AccountRef as AccountRef | undefined;
          const accountId = accountRef?.value || '';
          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Purchase',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: line.Amount as number, // Debit to expense account
            description: line.Description as string | undefined,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, accountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'deposit': {
        // Header: DepositToAccountRef is the bank account being debited
        const depositToRef = entity.DepositToAccountRef as AccountRef | undefined;
        const headerAccountId = depositToRef?.value || '';
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;

        if (headerAccountId && headerMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = headerAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Deposit',
            txnId,
            docNumber,
            lineId: 'header',
            amount: totalAmt, // Debit to bank account
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name || txnDeptRef?.value,
            qboLink,
            accountId: headerAccountId,
            accountName: getAccountName(headerAccountId, accountCache, depositToRef?.name),
            isMatchingLine: isMatching
          });
        }

        // Lines: DepositLineDetail.AccountRef
        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.DepositLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          const accountRef = detail.AccountRef as AccountRef | undefined;
          const accountId = accountRef?.value || '';
          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Deposit',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: -(line.Amount as number), // Credit to source account
            description: line.Description as string | undefined,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, accountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'salesreceipt': {
        // Header: DepositToAccountRef is the bank account being debited
        const depositToRef = entity.DepositToAccountRef as AccountRef | undefined;
        const headerAccountId = depositToRef?.value || '';
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;

        if (headerAccountId && headerMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = headerAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'SalesReceipt',
            txnId,
            docNumber,
            lineId: 'header',
            amount: totalAmt, // Debit to bank account
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name,
            qboLink,
            accountId: headerAccountId,
            accountName: getAccountName(headerAccountId, accountCache, depositToRef?.name),
            isMatchingLine: isMatching
          });
        }

        // Lines: SalesItemLineDetail - check ItemAccountRef for income account
        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.SalesItemLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          // Check ItemAccountRef (explicit account override on line)
          const itemAccountRef = detail.ItemAccountRef as AccountRef | undefined;
          const accountId = itemAccountRef?.value || '';
          if (!accountId) continue; // Skip lines without explicit account

          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          // Get item name for description context
          const itemRef = detail.ItemRef as { name?: string } | undefined;
          const itemName = itemRef?.name;
          const lineDesc = line.Description as string | undefined;
          const description = lineDesc || itemName;

          extractedLines.push({
            date: txnDate,
            type: 'SalesReceipt',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: -(line.Amount as number), // Credit to income account
            description,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, itemAccountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'bill': {
        // Header: APAccountRef is the AP account being credited
        const apAccountRef = entity.APAccountRef as AccountRef | undefined;
        const headerAccountId = apAccountRef?.value || '';
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;

        if (headerAccountId && headerMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = headerAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Bill',
            txnId,
            docNumber,
            lineId: 'header',
            amount: -totalAmt, // Credit to AP
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name || txnDeptRef?.value,
            qboLink,
            accountId: headerAccountId,
            accountName: getAccountName(headerAccountId, accountCache, apAccountRef?.name),
            isMatchingLine: isMatching
          });
        }

        // Lines: AccountBasedExpenseLineDetail for expense accounts
        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.AccountBasedExpenseLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          const accountRef = detail.AccountRef as AccountRef | undefined;
          const accountId = accountRef?.value || '';
          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Bill',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: line.Amount as number, // Debit to expense account
            description: line.Description as string | undefined,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, accountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'invoice': {
        // Header: DepositToAccountRef + Deposit, when part of the invoice was
        // paid at creation. The A/R debit for the unpaid balance has no
        // ARAccountRef on this entity and is not extractable.
        const depositToRef = entity.DepositToAccountRef as AccountRef | undefined;
        const depositAmt = entity.Deposit as number | undefined;
        const invoiceDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const invoiceMatchesDept = !departmentFilter || invoiceDeptRef?.value === departmentFilter;

        if (depositToRef?.value && depositAmt && invoiceMatchesDept) {
          const isMatching = depositToRef.value === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate, type: 'Invoice', txnId, docNumber, lineId: 'header',
            amount: depositAmt, // Debit to bank account
            description: entity.PrivateNote as string | undefined,
            department: invoiceDeptRef?.name || invoiceDeptRef?.value,
            qboLink,
            accountId: depositToRef.value,
            accountName: getAccountName(depositToRef.value, accountCache, depositToRef.name),
            isMatchingLine: isMatching
          });
        }

        // Lines: SalesItemLineDetail - check ItemAccountRef for income account
        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.SalesItemLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          // Check ItemAccountRef (explicit account override on line)
          const itemAccountRef = detail.ItemAccountRef as AccountRef | undefined;
          const accountId = itemAccountRef?.value || '';
          if (!accountId) continue; // Skip lines without explicit account

          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          // Get item name for description context
          const itemRef = detail.ItemRef as { name?: string } | undefined;
          const itemName = itemRef?.name;
          const lineDesc = line.Description as string | undefined;
          const description = lineDesc || itemName;

          extractedLines.push({
            date: txnDate,
            type: 'Invoice',
            txnId,
            docNumber,
            lineId: line.Id as string,
            amount: -(line.Amount as number), // Credit to income account
            description,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, itemAccountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'billpayment': {
        // Debits A/P, credits the bank or credit card the payment was drawn on.
        // Line[] holds LinkedTxn applications only — no account refs.
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        if (!departmentFilter || txnDeptRef?.value === departmentFilter) {
          const totalAmt = entity.TotalAmt as number;
          const department = txnDeptRef?.name || txnDeptRef?.value;

          const apRef = entity.APAccountRef as AccountRef | undefined;
          const checkPayment = entity.CheckPayment as { BankAccountRef?: AccountRef } | undefined;
          const cardPayment = entity.CreditCardPayment as { CCAccountRef?: AccountRef } | undefined;
          const payRef = checkPayment?.BankAccountRef || cardPayment?.CCAccountRef;

          // A/P side: debit (paying a bill reduces what is owed)
          if (apRef?.value) {
            const isMatching = apRef.value === targetAccountId;
            if (isMatching) hasMatchingLine = true;
            extractedLines.push({
              date: txnDate, type: 'BillPayment', txnId, docNumber, lineId: 'header',
              amount: totalAmt,
              description: entity.PrivateNote as string | undefined,
              department, qboLink,
              accountId: apRef.value,
              accountName: getAccountName(apRef.value, accountCache, apRef.name),
              isMatchingLine: isMatching
            });
          }

          // Funding side: credit
          if (payRef?.value) {
            const isMatching = payRef.value === targetAccountId;
            if (isMatching) hasMatchingLine = true;
            extractedLines.push({
              date: txnDate, type: 'BillPayment', txnId, docNumber, lineId: 'payment',
              amount: -totalAmt,
              description: entity.PrivateNote as string | undefined,
              department, qboLink,
              accountId: payRef.value,
              accountName: getAccountName(payRef.value, accountCache, payRef.name),
              isMatchingLine: isMatching
            });
          }
        }
        break;
      }

      case 'vendorcredit': {
        // Mirror image of a Bill: debits A/P, credits the expense accounts.
        const apAccountRef = entity.APAccountRef as AccountRef | undefined;
        const headerAccountId = apAccountRef?.value || '';
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;

        if (headerAccountId && headerMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = headerAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate, type: 'VendorCredit', txnId, docNumber, lineId: 'header',
            amount: totalAmt, // Debit to AP
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name || txnDeptRef?.value,
            qboLink,
            accountId: headerAccountId,
            accountName: getAccountName(headerAccountId, accountCache, apAccountRef?.name),
            isMatchingLine: isMatching
          });
        }

        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.AccountBasedExpenseLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          const accountRef = detail.AccountRef as AccountRef | undefined;
          const accountId = accountRef?.value || '';
          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate, type: 'VendorCredit', txnId, docNumber,
            lineId: line.Id as string,
            amount: -(line.Amount as number), // Credit to expense account
            description: line.Description as string | undefined,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, accountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'transfer': {
        // Two explicit sides, one Amount. No line items, no department.
        const amount = entity.Amount as number;
        const toRef = entity.ToAccountRef as AccountRef | undefined;
        const fromRef = entity.FromAccountRef as AccountRef | undefined;

        for (const [ref, signedAmount, lineId] of [
          [toRef, amount, 'to'],
          [fromRef, -amount, 'from'],
        ] as Array<[AccountRef | undefined, number, string]>) {
          if (!ref?.value) continue;
          const isMatching = ref.value === targetAccountId;
          if (isMatching) hasMatchingLine = true;
          extractedLines.push({
            date: txnDate, type: 'Transfer', txnId, docNumber, lineId,
            amount: signedAmount,
            description: entity.PrivateNote as string | undefined,
            department: undefined,
            qboLink,
            accountId: ref.value,
            accountName: getAccountName(ref.value, accountCache, ref.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'creditcardpayment': {
        // "Pay down credit card": debits the card, credits the bank. Flat entity
        // with no lines and no department.
        const amount = entity.Amount as number;
        const cardRef = entity.CreditCardAccountRef as AccountRef | undefined;
        const bankRef = entity.BankAccountRef as AccountRef | undefined;

        for (const [ref, signedAmount, lineId] of [
          [cardRef, amount, 'card'],
          [bankRef, -amount, 'bank'],
        ] as Array<[AccountRef | undefined, number, string]>) {
          if (!ref?.value) continue;
          const isMatching = ref.value === targetAccountId;
          if (isMatching) hasMatchingLine = true;
          extractedLines.push({
            date: txnDate, type: 'CreditCardPayment', txnId, docNumber, lineId,
            amount: signedAmount,
            description: entity.PrivateNote as string | undefined,
            department: undefined,
            qboLink,
            accountId: ref.value,
            accountName: getAccountName(ref.value, accountCache, ref.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'creditmemo': {
        // Reverses income; debits the income accounts. The A/R credit has no
        // ARAccountRef on this entity and is therefore not extractable.
        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.SalesItemLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          const itemAccountRef = detail.ItemAccountRef as AccountRef | undefined;
          const accountId = itemAccountRef?.value || '';
          if (!accountId) continue;

          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          const itemRef = detail.ItemRef as { name?: string } | undefined;

          extractedLines.push({
            date: txnDate, type: 'CreditMemo', txnId, docNumber,
            lineId: line.Id as string,
            amount: line.Amount as number, // Debit to income account (reversal)
            description: (line.Description as string | undefined) || itemRef?.name,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, itemAccountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'refundreceipt': {
        // Credits the bank refunded from, debits the income accounts.
        const depositToRef = entity.DepositToAccountRef as AccountRef | undefined;
        const headerAccountId = depositToRef?.value || '';
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;

        if (headerAccountId && headerMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = headerAccountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate, type: 'RefundReceipt', txnId, docNumber, lineId: 'header',
            amount: -totalAmt, // Credit to bank account
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name || txnDeptRef?.value,
            qboLink,
            accountId: headerAccountId,
            accountName: getAccountName(headerAccountId, accountCache, depositToRef?.name),
            isMatchingLine: isMatching
          });
        }

        const entityLines = (entity.Line as Array<Record<string, unknown>>) || [];
        for (const line of entityLines) {
          const detail = line.SalesItemLineDetail as Record<string, unknown> | undefined;
          if (!detail) continue;
          if (!matchesDepartment(detail)) continue;

          const itemAccountRef = detail.ItemAccountRef as AccountRef | undefined;
          const accountId = itemAccountRef?.value || '';
          if (!accountId) continue;

          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          const itemRef = detail.ItemRef as { name?: string } | undefined;

          extractedLines.push({
            date: txnDate, type: 'RefundReceipt', txnId, docNumber,
            lineId: line.Id as string,
            amount: line.Amount as number, // Debit to income account (reversal)
            description: (line.Description as string | undefined) || itemRef?.name,
            department: getDepartment(detail),
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, itemAccountRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }

      case 'payment': {
        // Header: DepositToAccountRef is where payment goes
        const depositToRef = entity.DepositToAccountRef as AccountRef | undefined;
        const accountId = depositToRef?.value || '';
        const txnDeptRef = entity.DepartmentRef as { value?: string; name?: string } | undefined;
        const headerMatchesDept = !departmentFilter || txnDeptRef?.value === departmentFilter;

        if (accountId && headerMatchesDept) {
          const totalAmt = entity.TotalAmt as number;
          const isMatching = accountId === targetAccountId;
          if (isMatching) hasMatchingLine = true;

          extractedLines.push({
            date: txnDate,
            type: 'Payment',
            txnId,
            docNumber,
            lineId: 'header',
            amount: totalAmt, // Debit to deposit account
            description: entity.PrivateNote as string | undefined,
            department: txnDeptRef?.name || txnDeptRef?.value,
            qboLink,
            accountId,
            accountName: getAccountName(accountId, accountCache, depositToRef?.name),
            isMatchingLine: isMatching
          });
        }
        break;
      }
    }

    // Only include lines from transactions that have at least one matching line
    if (hasMatchingLine) {
      lines.push(...extractedLines);
    }
  }

  return lines;
}
