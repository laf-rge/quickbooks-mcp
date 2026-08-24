// Handler for create_transfer — money moved between two of the company's own
// accounts.
//
// A Transfer is neither an expense nor a journal entry, and the difference
// matters after the fact. create_expense books the outflow to an expense
// account, overstating expenses and leaving the receiving account untouched.
// create_journal_entry posts the right two-sided result, but the transaction is
// then a JE: it does not read as a transfer in the register, and the bank-feed
// match screen will not offer it as one.
//
// Confirmed against a live company: QBO rejects a transfer whose two sides are
// the same account ("Duplicate From and To Accounts") and a non-positive amount
// ("Number out of range"). Both are caught here first, where the message can say
// which account and which amount.

import QuickBooks from "node-quickbooks";
import {
  promisifyWrite,
  getAccountCache,
  resolveAccountRef,
  toQboRef,
  type AccountRef,
} from "../../client/index.js";
import { buildQboUrl, validateAmount, toDollars, formatDollars } from "../../utils/index.js";
import type { AccountCache } from "../../types/index.js";

// The account types a transfer can legitimately touch. Restricted for the reason
// #24 gave create_bill_payment: this tool moves money, and an unrestricted
// partial match can land on an account that merely shares words with the
// intended one — on a real chart of accounts a Bank account named "… Credit"
// sits alongside the credit cards, so the guard is not hypothetical.
const TRANSFERABLE = ["Bank", "Credit Card"] as const;

function transferable(account: { AccountType?: string }): boolean {
  return (TRANSFERABLE as readonly string[]).includes(account.AccountType ?? "");
}

/**
 * Resolve one side of a transfer to a Bank or Credit Card account.
 *
 * resolveAccountRef matches account number, then name, then a partial
 * FullyQualifiedName — deliberately not Id, which elsewhere in this codebase is
 * a separate `account_id` parameter. A transfer takes one parameter per side, so
 * an id is accepted here, and where it sits in the order matters:
 *
 *   exact account number → exact name → exact id → partial name
 *
 * An id has to be tried before the partial match, because ids are short and
 * partial matching is a substring test: "20" is an account id here and also
 * appears inside "1020 Savings". It has to be tried after the exact forms, so a
 * token that is genuinely somebody's account number still resolves to that
 * account rather than being reinterpreted as an id.
 */
function resolveTransferAccount(cache: AccountCache, account: string, label: string): AccountRef {
  const key = account.trim().toLowerCase();
  const exactElsewhere = cache.items.some(
    a => a.AcctNum?.toLowerCase() === key || a.Name.toLowerCase() === key
  );

  if (!exactElsewhere) {
    const byId = cache.byId.get(account.trim());
    if (byId && transferable(byId)) {
      return {
        value: byId.Id,
        name: byId.FullyQualifiedName || byId.Name,
        acctNum: byId.AcctNum,
      };
    }
  }

  for (const accountType of TRANSFERABLE) {
    try {
      return resolveAccountRef(cache, account, { label, accountType });
    } catch {
      // Try the next permitted type before giving up.
    }
  }

  throw new Error(
    `${label} not found: "${account}". A transfer moves money between the ` +
      `company's own accounts, so it must name a Bank or Credit Card account.`
  );
}

export async function handleCreateTransfer(
  client: QuickBooks,
  args: {
    from_account: string;
    to_account: string;
    amount: number;
    txn_date: string;
    private_note?: string;
    draft?: boolean;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { from_account, to_account, amount, txn_date, private_note, draft = true } = args;

  if (!from_account || !to_account) {
    throw new Error("Both from_account and to_account are required");
  }

  const cache = await getAccountCache(client);
  const fromRef = resolveTransferAccount(cache, from_account, "From account");
  const toRef = resolveTransferAccount(cache, to_account, "To account");

  // Two different names can resolve to one account, so this is checked on the
  // resolved ids rather than on the strings the caller passed.
  if (fromRef.value === toRef.value) {
    throw new Error(
      `from_account and to_account both resolve to "${fromRef.name}" — a transfer ` +
        `must move money between two different accounts.`
    );
  }

  const amountCents = validateAmount(amount, "Transfer amount");
  if (amountCents <= 0) {
    throw new Error("Transfer amount must be positive");
  }

  const transfer = {
    FromAccountRef: toQboRef(fromRef),
    ToAccountRef: toQboRef(toRef),
    Amount: toDollars(amountCents),
    TxnDate: txn_date,
    ...(private_note && { PrivateNote: private_note }),
  };

  if (draft) {
    const preview = [
      "DRAFT - Transfer Preview",
      "",
      `From: ${fromRef.name}`,
      `To:   ${toRef.name}`,
      `Date: ${txn_date}`,
      `Amount: $${formatDollars(amountCents)}`,
      `Memo: ${private_note || "(none)"}`,
      "",
      `${fromRef.name} decreases by $${formatDollars(amountCents)}; ` +
        `${toRef.name} increases by the same.`,
      "",
      "Set draft=false to create this transfer.",
    ].join("\n");

    return { content: [{ type: "text", text: preview }] };
  }

  const result = (await promisifyWrite<unknown>((cb) =>
    client.createTransfer(transfer, cb)
  )) as { Id: string };

  const response = [
    "Transfer Created!",
    "",
    `From: ${fromRef.name}`,
    `To:   ${toRef.name}`,
    `Date: ${txn_date}`,
    `Amount: $${formatDollars(amountCents)}`,
    "",
    `Transfer ID: ${result.Id}`,
    `View in QuickBooks: ${buildQboUrl("transfer", "txnId", result.Id)}`,
  ].join("\n");

  return { content: [{ type: "text", text: response }] };
}
