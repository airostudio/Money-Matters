import { cn } from "@/lib/utils";
import { Money } from "@/domain/money/money";

/**
 * Formats a Money for display. Display-only: this is the one place it's
 * fine to pass the amount through Number()/Intl — no further calculation
 * happens with the formatted output. Every calculation stays on the
 * Decimal-backed Money/Decimal.js path (see docs/decisions/0003).
 */
export function MoneyDisplay({
  amount,
  currency,
  className,
  showSign = false,
}: {
  amount: string;
  currency: string;
  className?: string;
  showSign?: boolean;
}) {
  const money = Money.of(amount, currency);
  const formatted = new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: currency === "BASE" ? "AUD" : currency,
    currencySign: "accounting",
  }).format(Number(money.toString()));

  return (
    <span
      className={cn(
        "tabular-nums",
        money.isNegative() && "text-destructive",
        showSign && money.isPositive() && "text-success",
        className,
      )}
    >
      {formatted}
    </span>
  );
}
