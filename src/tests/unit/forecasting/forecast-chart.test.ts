import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForecastChart } from "@/components/forecasting/forecast-chart";

const pts = (balances: string[]) => balances.map((balance, i) => ({ date: `2026-10-${String(5 + i).padStart(2, "0")}`, balance }));

describe("ForecastChart", () => {
  it("renders two distinct series (solid vs dashed), the threshold line, and an accessible label", () => {
    const html = renderToStaticMarkup(
      createElement(ForecastChart, {
        known: pts(["1000.0000", "800.0000", "1200.0000"]),
        statistical: pts(["1000.0000", "500.0000", "-100.0000"]),
        threshold: "300.0000",
        currency: "AUD",
      }),
    );
    expect(html).toContain('role="img"');
    expect(html).toContain("known commitments only");
    expect(html).toContain("stroke-primary");
    expect(html).toContain("stroke-warning");
    expect(html).toContain('stroke-dasharray="6 4"');
    expect(html).toContain("Low-cash threshold");
    expect(html).toContain("2026-10-05");
    expect(html).toContain("2026-10-07");
  });

  it("does not draw a threshold legend entry for a zero threshold, and survives a flat series", () => {
    const html = renderToStaticMarkup(
      createElement(ForecastChart, { known: pts(["5.0000", "5.0000"]), statistical: pts(["5.0000", "5.0000"]), threshold: "0.0000", currency: "AUD" }),
    );
    expect(html).not.toContain("Low-cash threshold");
    expect(html).not.toContain("NaN");
  });
});
