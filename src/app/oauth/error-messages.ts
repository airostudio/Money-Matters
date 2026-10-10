/**
 * The ONLY texts the authorize flow's error page can show. The page takes a reason KEY (never free text), so nothing an
 * attacker puts in a URL is ever reflected back, and none of these ever redirects anywhere: when the client or redirect
 * URI cannot be trusted, an error page is all there is.
 */
export const OAUTH_ERROR_MESSAGES = {
  invalid_request: {
    title: "This authorisation link is not valid",
    body: "The app did not send a complete request. Go back to the app and start again. Nothing has been shared.",
  },
  unknown_client: {
    title: "This app is not recognised",
    body: "The app that sent you here is not registered, or has been removed. Nothing has been shared.",
  },
  client_disabled: {
    title: "This app has been disabled",
    body: "An administrator of the organization has switched this app off. Nothing has been shared.",
  },
  redirect_mismatch: {
    title: "This app sent an address it is not registered for",
    body: "The address the app asked to return you to is not one its owner registered, so we have stopped. Nothing has been shared. Tell the app's developer.",
  },
  not_a_member: {
    title: "You are not a member of the organization this app belongs to",
    body: "An app can only be authorised by a person in the organization that registered it. Sign in with the account that belongs to that organization. Nothing has been shared.",
  },
  organization_archived: {
    title: "This organization is archived",
    body: "Nobody can authorise apps for an archived organization until an owner restores it. Nothing has been shared.",
  },
  csrf: {
    title: "That request could not be verified",
    body: "The approval form expired or did not come from this site. Go back to the app and start again. Nothing has been shared.",
  },
  session: {
    title: "You are signed out",
    body: "Your session ended before you answered. Go back to the app and start again. Nothing has been shared.",
  },
} as const;

export type OAuthErrorReason = keyof typeof OAUTH_ERROR_MESSAGES;

export function isOAuthErrorReason(value: unknown): value is OAuthErrorReason {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(OAUTH_ERROR_MESSAGES, value);
}
