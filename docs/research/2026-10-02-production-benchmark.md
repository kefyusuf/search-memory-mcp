# Sektör araştırması ve mevcut sistem karşılaştırması

Araştırma tarihi: 2 Ekim 2026. Kapsam: agent uygulamalarına web araması, kaynak içeriği ve yerel bilgi erişimi sağlayan MCP ürünleri. Resmî ürün belgeleri ve standartlar incelendi; ücretli sağlayıcılar satın alınmadı, karşılaştırmalı canlı performans testi yapılmadı.

## Ürün konumu

Kullanıcının belirlediği ilk canlı hedef: **internete açık, çok kullanıcılı ürün**. Önerilen ilk müşteri segmenti geliştiriciler ve küçük araştırma ekipleri; kaynak gösteren, Türkçe/İngilizce arama ve özel bilgi erişimi sağlayan hosted MCP servisidir. Segment önerisi henüz kullanıcı görüşmeleriyle doğrulanmış değildir. Mevcut yerel stdio/SQLite yapısı servis çekirdeği olarak kullanılabilir; public ürün mimarisi henüz mevcut değildir.

Yerel çalışmak, arama sorgularının dışarı çıkmadığı anlamına gelmez: sağlayıcı adaptörleri sorguları dış arama servislerine gönderir. Yerel olan bileşenler model çıkarımı, indeks, hafıza ve önbellektir. İnternetsiz çalışma iddiası yalnızca önceden hazırlanmış yerel veri/model kapsamı için yapılmalıdır.

## Resmî kaynaklardan çıkan beklentiler

| Referans | Belgede görülen yetenek / yaklaşım | Bu projeye etkisi |
| --- | --- | --- |
| [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search) | Arama derinliği, alan adı dahil etme/dışlama, tarih ve dil seçenekleri; yanıt/içerik ve kullanım bilgileri | Parametre doğruluğu, tarih güvenilirliği ve iş başına kaynak tüketimini görünür kılmak gerekir |
| [Exa Search](https://exa.ai/docs/reference/search) | Alan adı filtreleri, kaynak metni, highlights, publishedDate ve author gibi alanlar | Snippet listesinin ötesinde kaynak metadatası ve kanıt pasajları bir ürün beklentisidir |
| [SearXNG ayarları](https://docs.searxng.org/admin/settings/settings_search.html) | JSON çıktısı yapılandırılabilir; CAPTCHA ve erişim hataları için ayrı suspension ayarları vardır | Self-hosted entegrasyon yararlıdır; sağlayıcı hata türlerinin ayrılması gerekir |
| [MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) | `outputSchema`, `structuredContent`, davranış annotations ve araç güvenlik kuralları | JSON metni vermek ile protokol seviyesinde yapılandırılmış çıktı vermek ayrı işlerdir |
| [MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) | HTTP için yetkilendirme modeli; stdio için ortamdan kimlik bilgisi kullanımı | Yerel dağıtım ile paylaşılan internet servisinin güvenlik gereksinimleri ayrılmalıdır |
| [MCP SDK geçiş rehberi](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28) | Yeni protokol revizyonuna geçiş açık seçim ve uyumluluk çalışması gerektirir | SDK sürümünü artırmak tek başına güncel protokol uyumluluğu kanıtı değildir |
| [OWASP SSRF](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) | IP/domain doğrulaması, A/AAAA değerlendirmesi ve ağ seviyesinde savunma | URL kontrolünün gerçek bağlantı ve redirect davranışıyla birlikte test edilmesi gerekir |
| [SQLite journal_mode](https://www.sqlite.org/pragma.html#pragma_journal_mode) | MEMORY journal işlem ortasında çökme durumunda veri bütünlüğünü riske atar | Kalıcı hafıza/indeks için mevcut ayar bir yayın engeli olarak ele alınmalıdır |
| [Google SRE: SLO](https://sre.google/workbook/implementing-slos/) | Kullanıcı odaklı başarı ve gecikme göstergeleri; error budget | Test sayısının yanında gerçek servis davranışını ölçmek gerekir |
| [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) | CI üzerinden OIDC ile yayın | Yerel paket yayını için uzun ömürlü yayın anahtarları yerine kontrollü CI tasarlanabilir |
| [npm provenance](https://docs.npmjs.com/generating-provenance-statements/) | Kaynak ve build arasında doğrulanabilir bağlantı; kod güvenliğini tek başına garanti etmez | Provenance, test ve güvenlik denetimini tamamlayan yayın kanıtıdır |

Bu tablo rakiplerin SLA, hız veya kalite üstünlüğünü kanıtlamaz. Bunlar belgelenmiş özellik karşılaştırmalarıdır. Önerilen kapsam ve öncelikler, bu özelliklerle yerel kod incelemesinin birlikte değerlendirilmesidir.

## Mevcut projede durum

| Boyut | Mevcut durum | Eksik / değerlendirme |
| --- | --- | --- |
| Arama | 5 adaptör, fallback/aggregate/auto, allowlist, RRF, opsiyonel expansion | Gerçek sağlayıcı kalitesi ve sürekliliği ölçülmemiş |
| İçerik ve kaynak | HTTP-first, Markdown, GitHub/RSS yolları, deep cevaplarda kaynaklar | Yayın zamanı/çekim zamanı/kanıt pasajı standart bir şemada değil |
| Türkçe desteği | Locale heuristics, TR/EN routing fixture'ları, multilingual embedding | Dil bazında gerçek kalite benchmark'ı yok |
| Yerel bilgi | Chunking, FTS5/vector retrieval, entity graph, session notes | Tam belge silme, saklama politikası, migration ve restore akışı ürünleştirilmemiş |
| MCP | stdio ve 11 araç; JSON isteğinde TextContent içinde JSON | `outputSchema` ve `structuredContent` kullanılmıyor; tool annotations yok |
| Protokol uyumluluğu | Kurulu SDK 1.29.0, en yeni desteklenen revizyon 2025-11-25 | 2026-07-28 uyumluluğu mevcut değil; hedef istemcilerle ayrıca değerlendirilmeli |
| Güvenlik | URL/protocol/IP kontrolleri, redirect ve browser request kontrolleri, rate limits | SSRF edge case'leri, bağlantı hedefi, byte limitleri ve prompt injection sınırları doğrulanmalı |
| Operasyon | Provider history/backoff, son arama izleri, durum aracı | Kalıcı metrikler, p95, deadline/cancellation, olay müdahalesi yok |
| Dağıtım | npm paket yapısı, CI, Docker/Compose taslağı | Temiz kurulum matrisi ve gerçek container smoke kanıtı yok |
| Paylaşılan servis | HTTP transport yok | Auth, tenant isolation, kullanıcı kotası ve API operasyonları henüz tasarlanmamış |

Kod kanıtları: `src/index.ts`, `src/search/`, `src/providers/`, `src/format/structured-output.ts`, `src/ssrf.ts`, `src/fetch-module.ts`, `src/knowledge/index-store.ts`, `src/cache/`, `src/memory/session-memory.ts`, `Dockerfile`, `.github/workflows/ci.yml`. SDK protokol listesi kurulu `node_modules/@modelcontextprotocol/sdk/dist/esm/types.js` üzerinden kontrol edildi.

## Yayın kapsamı kararı

İlk sürüm için web search + güvenilir içerik alma + kaynaklı yerel retrieval yeterli çekirdektir. Daha fazla graph özelliği, otonom crawler, PDF/OCR, multimodal arama, ödeme ve çok kullanıcılı yönetim bu çekirdeğin kalitesinden önce gelmemelidir.

İlk dağıtım hedefi hosted serviste davetli pilot, ardından kontrollü public beta ve GA'dır. Yerel paket test/geliştirme kanalı olarak korunabilir; public hedefin ön koşulu olarak yerel paket pazara çıkışı planlanmaz. Self-hosted SearXNG, upstream arama motorlarına bağımlılığı veya bunların kullanım koşullarını ortadan kaldırmaz; sağlayıcı seçimi için kullanım koşulları ve operasyon maliyeti ayrıca incelenmelidir.

Uygulama sırası ve ölçülebilir yayın kapıları: [production-roadmap.md](../production-roadmap.md).
