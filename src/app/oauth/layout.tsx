export const metadata = {
  title: "Authorise an app",
  // The consent screen and its errors are never worth indexing or caching.
  robots: { index: false, follow: false },
};

export default function OAuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-8">
      <div className="w-full max-w-lg">
        <div className="mb-6 text-center">
          <span className="text-xl font-semibold tracking-tight">Money Matters</span>
        </div>
        {children}
      </div>
    </div>
  );
}
