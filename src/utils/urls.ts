// URL generation utilities for QuickBooks Online

const PRODUCTION_HOST = "https://app.qbo.intuit.com";
const SANDBOX_HOST = "https://app.sandbox.qbo.intuit.com";

// Transaction ids are small integers that exist in both realms, so a production
// host on a sandbox link silently opens the real company's transaction with the
// same id. Derive the host from the same flag that switches the API base URL.
// Read at call time rather than at module load so the host stays correct
// regardless of when the environment is populated relative to imports.
export function getQboAppHost(): string {
  return process.env.QBO_SANDBOX === "true" ? SANDBOX_HOST : PRODUCTION_HOST;
}

// Build an app deep link for a known route. Callers that already know their
// entity's route use this directly; getQboUrl resolves the route by entity name.
export function buildQboUrl(
  path: string,
  idParam: "txnId" | "nameId",
  id: string,
): string {
  return `${getQboAppHost()}/app/${path}?${idParam}=${id}`;
}

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
  if (txnPath) return buildQboUrl(txnPath, "txnId", id);
  const namePath = NAME_URL_MAP[key];
  if (namePath) return buildQboUrl(namePath, "nameId", id);
  return null;
}
