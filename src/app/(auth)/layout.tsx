export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="text-xl font-semibold tracking-tight">Money Matters</span>
          <p className="mt-1 text-sm text-muted-foreground">The financial operating system for business.</p>
        </div>
        {children}
      </div>
    </div>
  );
}
