# Benzer açık kaynak MCP projeleri: temel özellikler ve farklılaşma

Araştırma tarihi: 9 Ekim 2026. Kaynaklar proje README'leri ve dizin listeleridir; kod çalıştırılmadı, kalite/hız karşılaştırması yapılmadı. Yıldız sayıları araştırma anındaki değerlerdir.

## İncelenen projeler

| Proje | Alan | Öne çıkanlar |
| --- | --- | --- |
| [sweetcornna/free-search-mcp](https://github.com/sweetcornna/free-search-mcp) (Python, MIT, ~126★) | Anahtarsız arama + fetch | 11 araç: `search`, `research`, `compare`, `fetch_batch`, `read_doc` (PDF/DOCX/XLSX/PPTX/EPUB/CSV/arşiv), `extract_structured` (JSON-LD/OpenGraph), `cache_search`, `paper_graph`; tazelik/`include_text` filtreleri; engellenen motoru yedekle değiştirme ve bunu raporlama; tür bazlı cache TTL; MCP prompts + resource templates; streamable HTTP |
| [Aas-ee/open-webSearch](https://github.com/Aas-ee/open-webSearch) (TypeScript) | Anahtarsız çoklu motor | Bing/Baidu/DDG/Brave/Startpage/Exa vb.; GitHub README ve CSDN içerik çekme; proxy; streamable HTTP/SSE; Docker imajı; CLI + daemon |
| [nickclyde/duckduckgo-mcp-server](https://github.com/nickclyde/duckduckgo-mcp-server) | DDG arama + fetch | En yaygın basit seçenek; yerleşik hız limitleri |
| [basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory) (AGPL-3.0, ~4.1k★) | Hafıza / bilgi tabanı | Hafıza düz Markdown dosyaları (insan da düzenleyebilir), wikilink tabanlı grafik, `build_context`, `recent_activity`, proje ayrımı, tool annotations (read-only/destructive) |
| [Resmî memory server](https://github.com/modelcontextprotocol/servers) | Hafıza | Varlık–ilişki–gözlem grafiği, JSONL; küçük ölçek için |
| Mem0 / OpenMemory | Hafıza | OpenMemory 2026'da kaldırıldı; Mem0 artık hosted MCP. Yerel hafıza boşluğu oluştu |
| minirag-mcp, shinpr/mcp-local-rag | Yerel RAG | Klasör indeksleme, BM25 + vektör RRF, ağsız ingest |

## Bizde olan / eksik olan (temel beklentiler)

| Özellik | Rakiplerde | Bizde |
| --- | --- | --- |
| Çoklu motor + fallback + RRF | Yaygın | Var |
| HTTP-first fetch + Playwright fallback | Yaygın | Var |
| Yerel hibrit RAG (FTS + vektör) | Var | Var |
| Hafıza + varlık grafiği | Var | Var |
| Tek çağrıda "araştır" (ara + oku + kaynaklı özet) | free-search-mcp `research` | Kısmen (`web_search` deep modu) — ayrı araç yok |
| Belge formatları (PDF/DOCX/XLSX/EPUB) | free-search-mcp, rag-mcp | **Eksik** — `ingest_document` yalnızca metin alıyor |
| Toplu fetch / URL karşılaştırma | free-search-mcp | **Eksik** |
| Yapısal metadata (JSON-LD, OpenGraph, yayın tarihi kaynağı) | free-search-mcp | **Eksik** |
| Tool annotations (readOnly/destructive) | basic-memory | **Eksik** |
| `outputSchema` / `structuredContent` | Yeni MCP sürümü | **Eksik** (JSON metin olarak dönüyor) |
| MCP prompts / resources | free-search-mcp, basic-memory | **Eksik** |
| Klasör indeksleme / dosya izleme | minirag, mcp-local-rag | **Eksik** |
| Tür bazlı cache TTL (haber kısa, doküman uzun) | free-search-mcp | Kısmen (tek TTL) |
| Engellenen motorun raporlanması | free-search-mcp | Kısmen (health/backoff var, yanıtta raporlanmıyor) |
| Proxy ayarı | Yaygın | Kontrol edilmeli |
| Streamable HTTP | Yaygın (çoğu kimlik doğrulamasız) | Auth katmanı hazırlanıyor, listener yok |

## Farklılaşma fırsatları

Rakipler ya **arama** ya da **hafıza** yapıyor; ikisini birleştiren yerel, anahtarsız bir proje görmedik. Önerilen farklar:

1. **Araştırma hafızası döngüsü.** Arama/okuma sonuçları otomatik olarak kaynaklı bilgi tabanına düşer; sonraki sorular önce yerel bilgiden, gerekirse webden cevaplanır. "Bunu daha önce nerede okumuştum?" sorusuna kaynak ve tarihle cevap.
2. **Kanıt ve tazelik etiketleri.** Her iddianın kaynak pasajı, yayın tarihi, çekim tarihi ve tarihin nereden alındığı. Yerel bilgi eskidiğinde (kaynak sayfa değişmiş) uyarı.
3. **Değişiklik takibi.** İndekslenen bir URL'yi periyodik yeniden çekip neyin değiştiğini (diff) raporlama — dokümantasyon, fiyat, sürüm notları için.
4. **İnsan tarafından okunabilir hafıza dışa aktarımı.** Basic Memory'nin güçlü yanı; hafıza ve notları Markdown klasörüne iki yönlü aktarmak bizi kilitlenmeden kurtarır (OpenMemory'nin kapanmasıyla oluşan yerel hafıza boşluğu).
5. **Türkçe/çok dilli öncelik.** Türkçe sorgu yeniden yazma, Türkçe kaynak motorları ve TR değerlendirme seti; rakiplerin dil odağı İngilizce/Çince.
6. **Güvenlik varsayılan olarak.** Rakiplerin HTTP modu kimlik doğrulamasız ve her URL'yi çekiyor; bizde SSRF koruması ve hazırlanan auth/tenant katmanı ayırt edici bir nokta.

## Birleşik iş listesi

Bu liste, [geliştirme durumu](../development-status.md) ve [üretim yol haritası](../production-roadmap.md) içindeki mevcut işlerle birlikte okunmalıdır; onların yerini almaz.

**Ürün özellikleri (bu araştırmadan)**

1. Hızlı temel: tool annotations, `outputSchema`/`structuredContent`, yanıtta engellenen motor raporu, tür bazlı cache TTL.
2. Belge desteği: PDF/DOCX/EPUB/HTML için `ingest_document` dosya/URL girişi; klasör indeksleme.
3. `research` aracı (ara + oku + kaynaklı özet + otomatik indeksleme) — farklılaşma 1'in çekirdeği.
4. Kanıt/tazelik şeması ve değişiklik takibi.
5. Markdown hafıza dışa/içe aktarımı.

**Mevcut yol haritası işleri (açık kalmaya devam ediyor)**

- A. Kimlik doğrulamalı üyelik yönetimi (sürüm kontrolü/çakışma politikası), ardından barındırılan veri işlem kilitleme ve ilk açılış kurulumu.
- B. Gerçek HTTP MCP uç noktası, barındırılan araçlar ve dağıtık kotalar.
- C. Arama sağlayıcılarının canlı ölçümü (başarı, engellenme, gecikme) ve sorgu genişletmenin kalite setiyle değerlendirilmesi.
- D. `src/index.ts` içindeki araç işleyicilerinin ayrı dosyalara taşınması.

**Önerilen sıra:** D → 1 → C → 2 → 3 → 4 → A → B → 5. D yeni araçları eklemeyi kolaylaştırdığı için önce gelir; C, 1'deki engellenen motor raporuyla aynı veriyi kullanır. A ve B hosted hedefin yayın kapıları olarak kalır ve yerel ürün farklılaşmasını bekletmez.
