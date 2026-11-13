import { describe, expect, it } from "vitest";
import {
  decodeBingUrl,
  decodeDuckDuckGoUrl,
  filterSearchResultsByDomain,
  inferSearchLocale,
  normalizeDomainFilter,
  parseBingResults,
  parseBraveResults,
  parseDuckDuckGoResults,
  parseGoogleResults,
  resolveSearchLocale,
} from "../search-utils.js";

describe("search-utils", () => {
  it("normalizes domain filters", () => {
    expect(normalizeDomainFilter("https://www.react.dev/reference")).toBe("react.dev");
    expect(normalizeDomainFilter("www.github.com")).toBe("github.com");
  });

  it("filters results by exact domains and subdomains", () => {
    const results = filterSearchResultsByDomain(
      [
        { title: "React", url: "https://react.dev/reference", snippet: "Docs", source: "test" },
        { title: "Blog", url: "https://engineering.react.dev/post", snippet: "Post", source: "test" },
        { title: "Other", url: "https://example.com/react", snippet: "Other", source: "test" },
      ],
      "react.dev",
    );

    expect(results.map((result) => result.title)).toEqual(["React", "Blog"]);
  });

  it("should infer Turkish locale for Turkish finance queries", () => {
    const locale = inferSearchLocale("alt\u0131n fiyat\u0131");
    expect(locale.market).toBe("tr-TR");
    expect(locale.acceptLanguage).toContain("tr-TR");
  });

  it("should prefer detected language over heuristic locale", () => {
    const locale = resolveSearchLocale("alt\u0131n fiyat\u0131", "eng_Latn");
    expect(locale.market).toBe("en-US");
    expect(locale.acceptLanguage).toContain("en-US");
  });

  it("should map detector output to German locale", () => {
    const locale = resolveSearchLocale("goldpreis", "deu_Latn");
    expect(locale.market).toBe("de-DE");
    expect(locale.acceptLanguage).toContain("de-DE");
  });

  it("should decode DuckDuckGo redirect urls", () => {
    const decoded = decodeDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Faltin.doviz.com%2F");
    expect(decoded).toBe("https://altin.doviz.com/");
  });

  it("should parse current DuckDuckGo result links", () => {
    const html = `
      <html><body>
        <table>
          <tr>
            <td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Faltin.doviz.com%2F">Alt\u0131n Fiyatlar\u0131</a></td>
          </tr>
          <tr>
            <td class="result-snippet">Canl\u0131 alt\u0131n kuru ve anl\u0131k fiyatlar.</td>
          </tr>
        </table>
      </body></html>
    `;
    const results = parseDuckDuckGoResults(html);
    expect(results).toEqual([
      {
        title: "Alt\u0131n Fiyatlar\u0131",
        url: "https://altin.doviz.com/",
        snippet: "Canl\u0131 alt\u0131n kuru ve anl\u0131k fiyatlar.",
        source: "duckduckgo",
      },
    ]);
  });

  it("should decode Bing tracking urls", () => {
    const url = decodeBingUrl("https://www.bing.com/ck/a?!&&p=123&u=a1aHR0cHM6Ly9nb2xkcHJpY2Uub3JnLw&ntb=1");
    expect(url).toBe("https://goldprice.org/");
  });

  it("should parse Bing results and decode target urls", () => {
    const html = `
      <html><body>
        <li class="b_algo">
          <h2><a href="https://www.bing.com/ck/a?!&&p=123&u=a1aHR0cHM6Ly9nb2xkcHJpY2Uub3JnLw&ntb=1">Gold Price Charts</a></h2>
          <div class="b_caption"><p>Live market charts.</p></div>
        </li>
      </body></html>
    `;
    const results = parseBingResults(html);
    expect(results).toEqual([
      {
        title: "Gold Price Charts",
        url: "https://goldprice.org/",
        snippet: "Live market charts.",
        source: "bing",
      },
    ]);
  });

  it("should parse Brave results from raw html", () => {
    const html = `
      <html><body>
        <div class="snippet">
          <a class="svelte-14r20fy l1" href="https://bigpara.hurriyet.com.tr/altin/">
            <div class="site-name-wrapper">Bigpara</div>
            Alt\u0131n Fiyatlar\u0131 - Canl\u0131 Alt\u0131n Kuru
          </a>
          <div class="generic-snippet">
            <div class="content">Anl\u0131k alt\u0131n fiyatlar\u0131 ve piyasa \u00f6zeti.</div>
          </div>
        </div>
      </body></html>
    `;
    const results = parseBraveResults(html);
    expect(results[0]).toEqual({
      title: "Bigpara Alt\u0131n Fiyatlar\u0131 - Canl\u0131 Alt\u0131n Kuru",
      url: "https://bigpara.hurriyet.com.tr/altin/",
      snippet: "Anl\u0131k alt\u0131n fiyatlar\u0131 ve piyasa \u00f6zeti.",
      source: "brave",
    });
  });

  it("should parse Google results with heading links", () => {
    const html = `
      <html><body>
        <div>
          <div>
            <a href="https://example.com/mcp-guide">
              <h3>Model Context Protocol Guide</h3>
            </a>
            <div>
              <span class="aCOpRe">A concise guide to MCP servers and tools.</span>
            </div>
          </div>
        </div>
      </body></html>
    `;

    const results = parseGoogleResults(html);

    expect(results[0]).toEqual({
      title: "Model Context Protocol Guide",
      url: "https://example.com/mcp-guide",
      snippet: "A concise guide to MCP servers and tools.",
      source: "google",
    });
  });
});
