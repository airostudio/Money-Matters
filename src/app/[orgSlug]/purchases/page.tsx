import { ShoppingCart } from "lucide-react";
import { ComingSoon } from "@/components/shell/coming-soon";

export default function PurchasesPage() {
  return (
    <ComingSoon
      icon={ShoppingCart}
      title="Purchases"
      phase={4}
      blurb="Suppliers, purchase orders, bills, three-way matching, and payment runs."
    />
  );
}
