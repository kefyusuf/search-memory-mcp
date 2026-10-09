# Sektör güncellemesi ve öncelikli iş listesi

Tarih: 9 Ekim 2026. Kaynaklar: MCP spesifikasyonu ve blogu, OWASP, ürün belgeleri, bağımsız ve satıcı kaynaklı karşılaştırmalar (satıcı kaynaklı sayılar yön gösterici kabul edilmelidir). Önceki karşılaştırma: [rakip özellikleri](2026-10-09-competitor-features.md).

## Bugünkü durum (doğrulanmış)

| Alan | Durum |
| --- | --- |
| Araçlar | 12 araç; etiketler (annotations), yapısal çıktı (`web_search`, `search_index`, `server_status`, `research`) |
| Arama | Sağlayıcı denemeleri yanıtta raporlanıyor; tür bazlı önbellek süresi; canlı ölçüm aracı (`benchmark:providers`, `--dump`) |
| Belgeler | PDF/DOCX/EPUB/HTML; URL ve izinli klasörlerden yerel dosya |
| Farklılaştırıcı | `research`: yerel bilgi + web + kaynaklı cevap + otomatik indeksleme; yayın ve çekim tarihleri |
| Dağıtım | npm; GHCR'de herkese açık Docker imajı (amd64/arm64); isteğe bağlı SearXNG |
| Kalite | 713 test, MCP smoke, uçtan uca senaryo (`npm run e2e`: yerelde 10/10 geçti, web adımları ağ olan makinede çalışır) |

Canlı ölçüm (kullanıcı ağı, Ekim 2026): DuckDuckGo 16/16; Bing aralıklı "sonuç yok" sayfası; Brave HTTP 429; Google yalnızca JavaScript isteyen sayfa döndürüyor. **Tek güvenilir varsayılan motor DuckDuckGo.**

## Sektörde ne değişti

1. **MCP 2026-07-28 spesifikasyonu**: çekirdek durumsuz (stateless) hale geldi, oturum el sıkışması kalktı; uzun işler için *Tasks* resmî eklenti oldu (`tasks/get` ile sorgulama); sunucudan istemciye istekler çok turlu isteklerle (MRTR) yürüyor; elicitation'da form ve URL modu var; MCP Apps (sunucu tarafından çizilen arayüz) ilk resmî eklenti. Yetkilendirme sıkılaştı. TypeScript SDK v2 yeni paket adlarıyla geldi (`@modelcontextprotocol/server`, `/client`); mevcut `@modelcontextprotocol/sdk` 1.32.1 en fazla 2025-11-25 sürümünü destekliyor. ([spec blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [Cloudflare v2 geçiş](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/))
2. **Güvenlik**: dolaylı prompt injection (araç çıktısında gizli talimat), tool poisoning / rug pull ve "confused deputy" en çok konuşulan riskler. OWASP önerisi: araç çıktısını güvenilmez kabul etmek, tanımları sabitlemek, en az yetki, hassas eylemlerde onay. Arama ve sayfa okuyan bir sunucu bu riskin tam merkezinde. ([OWASP MCP cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html), [OWASP tool poisoning](https://owasp.org/www-community/attacks/MCP_Tool_Poisoning))
3. **Ajan arama API'leri**: Brave, Exa, Parallel, Firecrawl, Tavily, Perplexity karşılaştırmalarda birbirine yakın; fiyatlar 1.000 sorgu başına ~0,25–8 $. Öne çıkan özellik "highlights": sayfanın tamamı yerine sorguya en ilgili pasajları döndürüp token tasarrufu. ([Parallel](https://parallel.ai/articles/best-web-search-mcp), [Firecrawl](https://www.firecrawl.dev/blog/best-search-tools-for-agents), [openbenchmarks](https://openbenchmarks.com/web-search/best-web-search-api-for-ai-agents))
4. **Ajan hafızası**: Zep/Graphiti iki zamanlı (bi-temporal) bilgi grafiği ile "bir bilginin ne zaman doğru olduğu" ve "ne zaman kaydedildiği" ayrımı; LongMemEval/LoCoMo skorları satıcıya göre çok değişken. Dersler: zaman bilgisi, tekrarları birleştirme (consolidation), geri getirme ile cevaplamanın ayrı ölçülmesi. ([Mem0 benchmark rehberi](https://mem0.ai/blog/ai-memory-benchmarks-in-2026), [AutoMem karşılaştırması](https://automem.ai/blog/agent-memory-in-2026-an-honest-comparison-of-mem0-zep-letta-and-the-rest))
5. **Yerel RAG**: en yüksek getirili iki adım ikinci aşama yeniden sıralama (reranker) ve "contextual retrieval" (her parçaya bağlam ekleyip indekslemek; Anthropic raporu başarısız getirmede %49, reranker ile %67 azalma). ([Anthropic](https://www.anthropic.com/engineering/contextual-retrieval))
6. **Dağıtım**: resmî MCP Registry (`server.json` ile) tek kanonik dizin haline geliyor; Claude Desktop için `.mcpb` paketleri tek tıkla kurulum sağlıyor. ([mcpb belgesi](https://claude.com/docs/connectors/building/mcpb), [registry rehberi](https://roxyapi.com/blogs/mcp-registries-where-to-list-your-server))

## Öncelikli iş listesi

Sıralama: kullanıcıya etki × risk azaltma ÷ maliyet. Her madde ayrı PR(lar) olarak, test önce yazılarak yapılır.

### P0: Güven ve güvenilirlik (hemen)

| # | İş | Neden | Boyut |
| --- | --- | --- | --- |
| 1 | **Web içeriğine prompt-injection koruması**: `fetch_content`/`research`/`web_search` çıktısını "güvenilmez içerik" sınırlarıyla sarmak, gizli metni (display:none, sıfır genişlikli karakterler, HTML yorumları) temizlemek, araç açıklamalarına uyarı eklemek; yazma yapan araçların (`research` indeksleme, `ingest_document`) bu riskini belgelemek | Sektörün 1 numaralı MCP riski; sunucumuz dış içeriği doğrudan modele veriyor | Orta |
| 2 | **Arama sürekliliği**: DuckDuckGo tek nokta arızası. İsteğe bağlı anahtarlı sağlayıcılar (Brave Search API, Exa veya Parallel) ekleyip varsayılanı anahtarsız bırakmak; Bing "sahte boş sayfa" için tekrar denemeli geri düşme | Ölçüm: güvenilir tek motor var | Orta |
| 3 | **Sürüm yayını**: `1.1.0` npm sürümü (CI'dan, provenance ile), `server.json`'ı güncelleyip resmî MCP Registry'ye kayıt, sürüm etiketiyle Docker imajı | Bugünkü tüm iyileştirmeler henüz npm kullanıcılarına ulaşmadı | Küçük |

### P1: Protokol ve dağıtım

| # | İş | Neden | Boyut |
| --- | --- | --- | --- |
| 4 | **MCP SDK v2 / 2026-07-28 geçişi**: durumsuz çekirdek; `research` için Tasks eklentisi (uzun araştırma arka planda); hosted HTTP yol haritasının ön koşulu | Yeni istemciler bu sürümle konuşacak; HTTP uç noktası planımız buna bağlı | Büyük |
| 5 | **`.mcpb` paketi** (Claude Desktop tek tık kurulum), README'de istemci başına kurulum | Node/npm sorunlarını kullanıcıdan tamamen kaldırır | Küçük |
| 6 | **Pasaj odaklı çıktı (highlights)**: `fetch_content`/`research` için sorguya en ilgili paragrafları döndüren mod | Rakiplerin standart özelliği; token tasarrufu | Orta |

### P2: Kalite ile farklılaşma

| # | İş | Neden | Boyut |
| --- | --- | --- | --- |
| 7 | **Bilgi tabanı kalitesi**: LLM gerektirmeyen contextual retrieval (parçaya belge başlığı ve bölüm başlığı eklemek), `search_index` için yerel reranker'ı varsayılan yapmak, değerlendirme setini genişletmek | Sektörde en yüksek getirili iki teknik | Orta |
| 8 | **Değişiklik takibi**: indekslenmiş URL'leri yeniden çekip farkı raporlamak (`watch_url`/`check_updates`), eskiyen kaynak uyarısı | Araştırmadaki 3. farklılaştırıcı; tarih etiketleri bunun temelini kurdu | Orta |
| 9 | **Zaman bilgili hafıza**: notlarda "geçerlilik/güncelleme" alanları, tekrar eden notları birleştirme, `recall`'da en günceli öne almak | Zep/Graphiti dersi; tarih etiketlerinin hafızaya uzantısı | Orta |
| 10 | **Markdown dışa/içe aktarma**: hafıza ve bilgi tabanını okunabilir dosyalara | Basic Memory ile eşitlik; kilitlenmeyi önler | Küçük |

### P3: Büyük hamleler (P0–P1 sonrası)

| # | İş | Not |
| --- | --- | --- |
| 11 | Barındırılan HTTP MCP + üyelik yönetimi (mevcut yol haritası A/B) | SDK v2 geçişinden sonra; mevcut auth/tenant çalışmaları buraya bağlanır |
| 12 | MCP Apps ile araştırma sonuçları arayüzü | İstemci desteği yaygınlaşınca |
| 13 | Hafıza için standart değerlendirme (LongMemEval benzeri küçük set) | Pazarlama iddiası değil, regresyon kontrolü için |

## Öneri

İlk adım olarak **P0-1 (prompt-injection koruması)** ve **P0-3 (1.1.0 sürümü + MCP Registry)**. Biri en büyük riski kapatır, diğeri yapılan işleri kullanıcıya ulaştırır. Ardından P0-2 ve P1-4.
