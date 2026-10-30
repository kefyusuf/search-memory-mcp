import { describe, expect, it } from "vitest";
import { panelHtml } from "../hosted/panel.js";

describe("operator panel", () => {
  it("renders the operator surface with connection info", () => {
    const html = panelHtml({ audience: "https://mcp.example.com/team/mcp", issuer: "https://auth.example.com", hostedEnabledTools: 12 });
    expect(html).toContain("Hosted Pilot Paneli");
    expect(html).toContain("https://mcp.example.com/team/mcp");
    expect(html).toContain("https://auth.example.com");
    expect(html).toContain("Content-Security-Policy");
  });

  it("escapes configuration values into the page", () => {
    const html = panelHtml({ audience: "https://mcp.example.com/team/mcp", issuer: "https://auth.example.com<script>alert(1)</script>", hostedEnabledTools: 12 });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
