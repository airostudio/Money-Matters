import type { ComingSoonProvider } from "./provider";

/**
 * Every integration master spec s.53 lists that is NOT built, labelled honestly. These are DESCRIPTORS ONLY: no connect,
 * no send, no config schema - nothing that could pretend to work (a test asserts none of them is in the provider
 * registry, and that the connection service refuses them). Each needs something this project does not have: an external
 * account, credentials, an OAuth application or a partner agreement.
 */
const CREDENTIALS = "Needs a registered developer account and API credentials with the provider, which this installation does not have.";
const OAUTH = "Needs an OAuth 2.0 application registered with the provider and the OAuth flow for third-party apps (not built yet).";

export const COMING_SOON_PROVIDERS: readonly ComingSoonProvider[] = [
  { id: "basiq", name: "Basiq", category: "BANKING", description: "Live Australian bank feeds through the Consumer Data Right.", availability: "COMING_SOON", needs: "Needs a Basiq account and API keys, and CDR accreditation or a CDR partner agreement." },
  { id: "plaid", name: "Plaid", category: "BANKING", description: "Bank feeds for supported countries.", availability: "COMING_SOON", needs: CREDENTIALS },
  { id: "yodlee", name: "Yodlee", category: "BANKING", description: "Bank and card data aggregation.", availability: "COMING_SOON", needs: CREDENTIALS },
  { id: "stripe", name: "Stripe", category: "PAYMENTS", description: "Card payments and payouts matched to invoices.", availability: "COMING_SOON", needs: CREDENTIALS },
  { id: "paypal", name: "PayPal", category: "PAYMENTS", description: "PayPal payments matched to invoices.", availability: "COMING_SOON", needs: CREDENTIALS },
  { id: "square", name: "Square", category: "PAYMENTS", description: "Point-of-sale and online payments.", availability: "COMING_SOON", needs: OAUTH },
  { id: "shopify", name: "Shopify", category: "ECOMMERCE", description: "Orders, refunds and payouts into the books.", availability: "COMING_SOON", needs: OAUTH },
  { id: "woocommerce", name: "WooCommerce", category: "ECOMMERCE", description: "Store orders into the books.", availability: "COMING_SOON", needs: CREDENTIALS },
  { id: "amazon", name: "Amazon Seller", category: "ECOMMERCE", description: "Marketplace settlements and fees.", availability: "COMING_SOON", needs: OAUTH },
  { id: "ebay", name: "eBay", category: "ECOMMERCE", description: "Marketplace sales and fees.", availability: "COMING_SOON", needs: OAUTH },
  { id: "hubspot", name: "HubSpot", category: "CRM", description: "Customers and deals shared with your CRM.", availability: "COMING_SOON", needs: OAUTH },
  { id: "salesforce", name: "Salesforce", category: "CRM", description: "Accounts and opportunities shared with your CRM.", availability: "COMING_SOON", needs: OAUTH },
  { id: "payroll_hr", name: "Payroll and HR systems", category: "PAYROLL_HR", description: "Employee and pay data from external payroll or HR systems.", availability: "COMING_SOON", needs: "Needs an agreement and API access with each payroll or HR vendor." },
  { id: "gmail", name: "Gmail", category: "PRODUCTIVITY", description: "Capture invoices and receipts from email.", availability: "COMING_SOON", needs: OAUTH },
  { id: "outlook", name: "Outlook", category: "PRODUCTIVITY", description: "Capture invoices and receipts from email.", availability: "COMING_SOON", needs: OAUTH },
  { id: "google_drive", name: "Google Drive", category: "STORAGE", description: "Attach and archive documents.", availability: "COMING_SOON", needs: OAUTH },
  { id: "onedrive", name: "OneDrive", category: "STORAGE", description: "Attach and archive documents.", availability: "COMING_SOON", needs: OAUTH },
  {
    id: "microsoft_teams",
    name: "Microsoft Teams",
    category: "MESSAGING",
    description: "Post automation messages to a Teams channel.",
    availability: "COMING_SOON",
    needs: "Deferred: the current supported incoming-webhook mechanism for Teams could not be verified from this repository, and Microsoft has been changing it. It will be added once it can be checked against the live documentation.",
  },
];
