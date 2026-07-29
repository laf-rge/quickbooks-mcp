// URL generation utilities for QuickBooks Online

// QBO app route per entity. Routes are not derivable from the entity name
// (journalentry → journal, purchase → expense), so only add a mapping once the
// route has been confirmed against a real transaction. Unmapped entities return
// null and callers omit the link rather than emit a guessed 404.
const TXN_URL_MAP: Record<string, string> = {
  journalentry: "journal",
  purchase: "expense",
  deposit: "deposit",
  salesreceipt: "salesreceipt",
  bill: "bill",
  billpayment: "billpayment",
  invoice: "invoice",
  payment: "payment",
};

// Name entities use nameId= instead of txnId=
const NAME_URL_MAP: Record<string, string> = {
  customer: "customerdetail",
};

// True when getQboUrl can produce a link for this entity type.
export function hasQboUrl(entityType: string): boolean {
  const key = entityType.toLowerCase();
  return key in TXN_URL_MAP || key in NAME_URL_MAP;
}

export function getQboUrl(entityType: string, id: string): string | null {
  const key = entityType.toLowerCase();
  const txnPath = TXN_URL_MAP[key];
  if (txnPath) return `https://app.qbo.intuit.com/app/${txnPath}?txnId=${id}`;
  const namePath = NAME_URL_MAP[key];
  if (namePath) return `https://app.qbo.intuit.com/app/${namePath}?nameId=${id}`;
  return null;
}
