import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OAUTH_ERROR_MESSAGES, isOAuthErrorReason } from "../error-messages";

export const dynamic = "force-dynamic";

/** Where the consent decision sends a person when it cannot continue. The reason is a fixed key, never reflected text. */
export default function OAuthErrorPage({ searchParams }: { searchParams: { reason?: string } }) {
  const reason = isOAuthErrorReason(searchParams.reason) ? searchParams.reason : "invalid_request";
  const message = OAUTH_ERROR_MESSAGES[reason];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{message.title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{message.body}</CardContent>
    </Card>
  );
}
