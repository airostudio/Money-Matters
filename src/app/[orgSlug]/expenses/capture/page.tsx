import { requireOrgAndActor } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { captureReceiptAction } from "../actions";

export default async function CaptureReceiptPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor: _actor, org } = await requireOrgAndActor(params.orgSlug);
  const boundCapture = captureReceiptAction.bind(null, org.slug);

  return (
    <div className="max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>Capture a receipt</CardTitle>
        </CardHeader>
        <form action={boundCapture} encType="multipart/form-data">
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Upload a photo or PDF of a receipt or invoice. If AI extraction is available, it will pre-fill a
              draft expense claim for you to review and edit — nothing is ever posted automatically from an
              upload. JPEG, PNG, WebP, GIF, or PDF, up to 10MB.
            </p>
            {searchParams.error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
            )}
            <input
              type="file"
              name="file"
              accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
              required
              className="block w-full text-sm"
            />
          </CardContent>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Button type="submit">Upload &amp; continue</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
