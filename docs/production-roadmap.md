# Üretime geçiş roadmap'i

Tarih: 2 Ekim 2026. Durum: araştırma ve kod incelemesine dayalı öneri; bu dosyadaki işler uygulanmış sayılmaz. Kaynaklı sektör karşılaştırması: [araştırma notu](research/2026-10-02-production-benchmark.md).

Uygulama kaydı: ilk geliştirme dalında P0-01'in domain/date cache doğruluğu alt kapsamı TDD ile uygulandı. Namespace filtrelemesi vector-store limiti öncesine alındı; filtered/unfiltered ve deep-hit senaryoları için regression testleri eklendi. Tenant-aware cache/storage ve public auth/isolation bu değişikliğin kapsamına dahil değildir; P0-01'in tamamı bitmiş sayılmaz.

## 1. Ürün hedefi ve canlı tanımı

Kullanıcının seçtiği ilk canlı hedef: **internete açık, çok kullanıcılı ürün (L3)**. Önerilen ilk segment geliştiriciler ve küçük araştırma ekipleri; hedef kullanım teknik dokümantasyon bulma, TR/EN kaynak araştırması ve bulunan sayfaları kullanıcıya özel, kaynak gösterilebilir bilgiye dönüştürme. Bu segment ve talep pilot kullanıcı görüşmeleriyle doğrulanacak.

Ürün vaadi: kaynakları ve hata durumlarını açıkça gösteren, yerel veriyi koruyan, sınırları belli bir arama/retrieval katmanı. Ağ gerektiren web araması için “tamamen offline” veya ölçülmemiş “her sağlayıcıda güvenilir” iddiası yapılmamalı.

Dağıtım seviyeleri ve sınırları; seçilen yol L3'e giden hosted pilot yoludur:

| Seviye | Dağıtım | Gerekli kapı |
| --- | --- | --- |
| L1: Yerel paket | İstemcinin başlattığı stdio süreç; kullanıcıya ait DB | Doğru sonuç sözleşmesi, veri güvenliği, güvenli fetch, temiz kurulum, kalite ölçümü ve yayın geri dönüşü |
| L2: Özel servis | Kurum ağı/VPN arkasındaki paylaşılan HTTP MCP | L1 + kimlik/yetki, kullanıcı veri yalıtımı, kota, HTTPS, metrikler, backup/restore ve olay yönetimi |
| L3: Public ürün | İnternet üzerinden çok kullanıcı/kurum | L2 + kötüye kullanım kontrolü, tenant sınırları, kapasite/cost yönetimi, müşteri destek süreçleri ve güvenlik değerlendirmesi |

Mevcut stdio süreci HTTP olarak proxy'lenip public açılmamalı. Hosted servis için authenticated principal, yetki ve tenant yönetimi ilk faz gereksinimidir; kullanıcıdan gelen `session` alanı kimlik veya yetki yerine kullanılamaz. [MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

## 1.1. Önerilen public mimari

İlk sürüm: tek bölge, sınırlandırılmış kapasite, modular monolith API ve ayrı kaynak yoğun iş yürütücüsü. Mikroservis/Kubernetes zorunlu başlangıç tercihi değildir. Hedef istemciler remote MCP host'larıdır; minimal web panel kullanıcı onboarding, bağlantı kurma, kota/usage, veri yönetimi ve servis durumunu kapsar. Genel amaçlı sohbet uygulaması ilk kapsam değildir.

Akış: MCP client -> TLS gateway -> HTTP MCP/auth katmanı -> tenant-aware tool/service katmanı -> search/fetch/embedding iş yürütücüsü -> sağlayıcılar veya tenant'a ait indeks.

- Kimlik: hazır OAuth/OIDC sağlayıcısı değerlendirilir; kullanıcı/kurum/workspace modeli, üyelik ve read/write yetkisi sunucu tarafından belirlenir. Admin işlemleri ayrı yetkilerle korunur.
- Veri: Postgres tabanlı metadata/notes/documents ve tenant-scoped vector retrieval (örneğin pgvector) ilk adaydır. SQLite kodu storage interface arkasında yerel mod için korunabilir. Seçim migration prototipi ve load/restore testinden sonra kesinleştirilir.
- Queue/cache: kota ve eşzamanlılık için paylaşılan store (örneğin Redis), bounded background queue; doküman/model/artifact depolaması gerektiğinde object storage. Tenant-aware cache zorunludur; kamuya ait içerik cache'i için ayrı gizlilik politikası gerekir.
- Ağ: browser/fetch worker'ları private subnet/metadata servislerine erişemeyen egress sınırı içinde; kullanıcı isteği model dosyası/komut/env veya sağlayıcı base URL yapılandırmasını değiştiremez.
- Ekonomi: istek sayısının yanında provider attempt, browser second, embedding işi ve veri saklama bütçeleri; kullanıcı başına sert üst limit ve servis genelinde harcama kesme mekanizması. Ücretli plan tasarımı beta ihtiyacına göre sonraya kalabilir.

Public ürün mimarisi mevcut koddan yapılan bir tasarım önerisidir; Postgres/Redis/object storage henüz uygulanmadı veya seçilmedi.

## 2. Bugünkü temel ve belirsizlikler

Önceki geliştirme turunda Node 24 ile 258 test, build, stdio smoke ve iki sorguluk FTS retrieval değerlendirmesi geçti; audit sıfır açık bildirdi. Bu araştırma turunda kod ve resmî belgeler yeniden incelendi; bu sonuçlar yeni bir canlı sağlayıcı testi değildir.

Mevcut `evals/retrieval/cases.jsonl` iki vaka, routing dosyası 17 vaka içeriyor. Küçük fixture başarısı, gerçek dünya arama kalitesi veya semantic retrieval doğruluğu için yeterli kanıt değil.

Kod incelemesinden çıkarılan öncelikli riskler:

| ID | Kanıt | Risk ve doğrulama ihtiyacı |
| --- | --- | --- |
| R1 | İlk incelemede cache tarihi/domain'i kesin kısıt olarak ayırmıyor ve hit'te tekrar filtrelemiyordu | Domain/date namespace + hit'te tekrar filtreleme regression testleriyle düzeltildi. Tenant sınırı henüz uygulanmadı |
| R2 | Cache, knowledge, memory ve graph aynı DB yolunu kullanıyor; hepsinde MEMORY journal ayarı var | Kalıcı kullanıcı verisi transaction sırasında crash durumunda risk altında. DB politikası ve crash/restore testi gerekiyor. [SQLite belgesi](https://www.sqlite.org/pragma.html#pragma_journal_mode) |
| R3 | `.nvmrc`/CI Node 24, Docker iki aşamada Node 20; `npm ci --ignore-scripts` kullanıyor | Runtime tutarsız; native SQLite modülünün container'da kurulumu kanıtlanmamış. Container build ve gerçek stdio bağlantısıyla doğrulanmalı |
| R4 | `ssrf.ts`: DNS hataları boş listeye dönüşüyor; IPv6 metinsel prefix'lerle inceleniyor | Belirsiz DNS davranışı, bracket/IPv4-mapped IPv6, link-local/metadata, rebinding ve bağlantı sırasında hedef değişimi için özel test gerekiyor; bütün bypass'ların doğrulandığı iddia edilmiyor |
| R5 | Fetch gövdesi `arrayBuffer()`/`text()` ile alınıyor; 50.000 karakter çıktı kırpması sonradan yapılıyor | Çıktı limiti, ağdan alınan byte veya parse sırasında kullanılan bellek için limit değil |
| R6 | `index-store.ts` belge başına yeni embedding provider açıyor; embedJob queue zincirine eklenmeden başlıyor | Eşzamanlı model yükleme ve ingestion kaynak tüketimi kontrolsüz büyüyebilir; single-flight model yükleme ve bounded queue ölçülmeli |
| R7 | `health.ts` boolean başarı tutuyor; `executor.ts` boş sonucu başarısız sayıyor | Gerçekten boş sorgu, selector kırılması, CAPTCHA, rate limit ve network error ayrışmıyor |
| R8 | Kurulu MCP SDK protokol listesi 2025-11-25'e kadar; smoke 2024-11-05 initialize kullanıyor | Güncel 2026-07-28 revizyonuyla uyumluluk kanıtı yok. Yeni revizyonda lifecycle değişti; migration hedef istemci matrisiyle planlanmalı. [SDK rehberi](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28) |

## 3. P0 — Public servis temeli, doğruluk ve güvenlik

2026-10-02 uygulama durumu: P0-00 için transporttan bağımsız tool dispatcher ve sunucu tarafından oluşturulan değiştirilemez request context eklendi. Scope/üyelik izin kesişimi, audience/expiry, context kaynağı, execution mode, deadline ve önceden iptal edilmiş istek kontrol ediliyor. Stdio bu akışı kullanıyor. Token imzası/issuer doğrulaması, HTTP/OAuth, tenant storage ve çalışan işlere cancellation yayılımı tamamlanmadı. Mevcut 11 handler yalnızca local modda açılıyor; bu nedenle hosted çağrı bu aşamada işlem başlamadan reddediliyor. P0-00 ve P0-00b tamamlanmış sayılmıyor.

P0-00b ilk depolama dilimi: SQLite session memory için execution mode + tenant + workspace sınırı, depoda read/write izin kontrolü ve workspace bazlı kapasite temizliği uygulandı. Eski notlar transaction içindeki eklemeli migration ile local alanda kalıyor; eşleşen id/session/topic diğer tenant verisine erişim vermiyor. Hosted araçlar hâlâ kapalı. Knowledge/graph/private cache izolasyonu, hosted DB adapter/migration, kotalar ve backup/restore tamamlanmadan public pilot kapısı açılmıyor. Sahiplik kolonlarını yok sayan eski sürüme aynı DB üzerinde rollback güvenli değil; scoped query sınırını koruyan sürüm veya ayrı local restore gerekiyor.

Bu faz hosted davetli pilotun ön koşuludur. Sorumlu roller: backend, auth/security, platform; doğrulama rolü: test ve release sorumlusu. Efor etiketi göreli büyüklüktür, teslim tarihi değildir.

| İş | Kapsam | Kabul kanıtı | Efor |
| --- | --- | --- | --- |
| P0-00 Hosted API ve identity | Hedef MCP protocol/client matrisi; uygun HTTP transport ve legacy uyumu; TLS; OAuth/OIDC integration, discovery, token audience/scope; read/write/admin izinleri; tool handlers transporttan ayrı | Gerçek host bağlantısı; unauthenticated/expired/wrong-audience/insufficient-scope isteği reddedilir; Origin/Host ve proxy testleri | L |
| P0-00b Tenant veri sınırı | Sunucudan türetilmiş tenant/workspace; storage abstraction ve shared DB migration; cache/index/memory/graph/browser isolation; RLS veya eşdeğer zorunlu query policy | Tenant A hiçbir araç/id/source/session ile B verisini okuyamaz/değiştiremez; queue ve cache dahil negatif testler; migration/restore raporu | L |
| P0-00c Kota ve abuse | Kullanıcı/IP/tenant bazında rate/concurrency limits, job budgets, body caps, signup/admin koruması, harcama üst sınırı; credential redaction | Eşzamanlı quota aşımı engellenir; request/batch ile limit baypas edilemez; abusive tenant diğer kullanıcıları tüketmez | M/L |
| P0-01 Cache/filter sözleşmesi | Filtreleri semantik benzerlikten bağımsız kesin metadata olarak ele al; hit'te tekrar domain/date uygula; cache raw vs filtered veri kararını yaz; namespace store katmanında filtrelensin | Aynı query + farklı tarih/domain, cache hit/miss, auto/aggregate/expanded, max_results ve deep regression testleri aynı filtre sözleşmesini korur | M |
| P0-02 Kalıcı DB güvenliği | Hosted DB/storage politikası ve migration; SQLite yerel geçiş sürecinde güvenli journal/sync ve busy timeout; disposable cache'i kullanıcı verisinden ayır | Process/worker kill + restart; tenant memory/knowledge/graph korunumu; storage-aware backup ve boş ortama restore testi; SQLite kalırsa integrity_check | M/L |
| P0-03 Güvenli ve sınırlı fetch | URL parsing/IP canonicalization; DNS/bağlantı tutarlılığı; her redirect ve browser subrequest kontrolü; streaming byte cap; süre/input/output sınırları | Loopback/IPv6/metadata/DNS değişimi/redirect testleri; büyük veya yavaş gövde kontrollü hata verir; internal egress denemesi engellenir | L |
| P0-04 İş bütçeleri | İstek toplam deadline'ı, AbortSignal/cancellation yayılımı, eşzamanlı fetch/browser/model sınırı, expansion toplam provider-attempt bütçesi | Üç varyantlı/fallback arama toplam bütçeyi aşmaz; iptalde sayfa/iş slotu serbest kalır; model yükleme tekilleşir | M |
| P0-05 Çalışabilir dağıtım | Node 24 uyumu; Docker native bağımlılık kurulumu; non-root süreç, yazılabilir model dizinleri; staging HTTPS/secret yönetimi; readiness/liveness ve kontrollü shutdown | Container + HTTP MCP smoke; deploy/restart'ta veri ve işler korunur; cold/warm başlangıç kaydı; ortamlar ve secrets ayrıdır | M |
| P0-06 Veri ve güven sınırı | Web içeriği untrusted veri olarak etiketlensin; kaynak talimatı çalıştırılmasın; query/text log redaksiyonu ve retention; belge silme bütün indeks/graph parçalarını temizlesin | Adversarial sayfa kaynaklı talimat testleri; log'da örnek hassas veri görünmez; silinen belge retrieval/graph'ta kalmaz | M |

SSRF tasarımındaki ağ seviyesinde egress önlemleri uygulama doğrulamasını tamamlar ve hosted worker'lar için zorunlu sınırdır. [OWASP yaklaşımı](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

P0-00b graph storage update (2026-10-02): document/entity/link keys, joins, replacement writes and statistics now enforce execution mode + tenant + workspace. Storage checks trusted-context provenance and knowledge read/write permissions. A transactional schema rebuild preserves legacy rows in the local scope; matching ids or entity names cannot cross workspaces. Built-in tools remain local-only. Knowledge/vector retrieval and private-cache ownership, hosted storage and quotas are still pending. Scope-aware rollback and backup/restore verification remain release requirements.

P0-00b knowledge storage update (2026-10-04): trusted context and read/write permissions now bound document, chunk, FTS/vector result and statistics access by mode/tenant/workspace before ordering/limits. New document ids are UUIDs; legacy ids/index rows stay in the local scope. Owned deletion clears vectors before chunks; queued embedding writes check surviving ownership and query waits recheck context. Private-cache isolation, hosted DB/quotas and operational gates remain pending. The shared FTS corpus and vector full scan require hosted performance/ranking validation; the per-index embedding queue is serialized but unbounded. Built-in tools remain local-only.

P0-00b private-cache update (2026-10-04): content URLs, native semantic metadata and JS fallback entries now bind to trusted mode/tenant/workspace ownership. Both vector paths preserve exact execution namespaces and filter before candidate limits. Migration keeps legacy caches local. Clear/TTL cleanup require cache:manage and affect only the owning scope; clear includes both persisted vector backends. SemanticCache preserves authorization and cancellation through inference/fallback paths. Hosted HTTP/auth wiring, browser resources, quotas, durable hosted storage and load/restore evidence remain pending. No shared public cache or hosted tool is enabled.

P0-00c concurrency update (2026-10-04): hosted dispatch now requires an explicit admission policy. A process-local reference enforces global, tenant, workspace and principal concurrency atomically and counts every invocation using trusted identities. A shared policy instance prevents separate dispatchers or repeated request IDs from bypassing limits. Handler settlement releases capacity once; aborted work retains its grant until it actually settles. Context is rechecked after admission/handler/release waits. Distributed quotas, rate/IP/batch ingress limits, cost budgets, bounded internal work, forced cancellation and hosted bootstrap configuration remain pending. Built-in handlers remain local-only; this is not a public launch gate completion.

P0-00c rate update (2026-10-04): the process-local shared admission policy now supports explicit sliding-window global/tenant/workspace/principal accepted-call limits. It uses monotonic time and individually expires timestamps; denied attempts consume neither rate nor concurrency capacity. Failed/cancelled accepted invocations retain rate usage. All expired identity histories are swept on admission checks so state is bounded by configured global accepted usage. Configuration is optional for compatibility and must be selected explicitly by hosted bootstrap. Distributed/durable quotas, unauthenticated HTTP/IP/signup/batch protection, spend budgets and bounded internal work remain pending. Built-in handlers remain local-only.

P0-04 knowledge queue update (2026-10-04): active plus pending embedding chunks are now bounded per KnowledgeIndex instance with a configurable positive safe-integer limit (local default 256). Overload rejects ingest before document/chunk/FTS writes; failed SQL does not reserve capacity. Embedding job settlement releases its reservation, while document deletion does not hide pending work. FTS-only ingestion schedules no inference. Cross-index/model concurrency, input/storage byte budgets, model single-flight, inference deadlines/forced cancellation and durable worker recovery remain pending. The earlier unbounded-queue observation is superseded for this per-index backlog only.

## 4. P1 — Ölçülebilir arama kalitesi ve ürün sözleşmesi

P0 bulguları çözülmeden yeni kapsam büyütülmemeli. Sorumlu roller: retrieval geliştiricisi + değerlendirme sorumlusu.

| İş | Kapsam | Kabul kanıtı | Efor |
| --- | --- | --- | --- |
| P1-01 Kaynak şeması | Stable result/source id, canonical URL, provider provenance, fetchedAt, güvenilir publishedAt + tespit yöntemi, excerpt/kanıt pasajı, cache age ve partial/degraded durumları | Text/JSON çıktıları aynı kaynakları taşır; bilinmeyen tarih uydurulmaz; geçersiz tarih ve ters aralık reddedilir | M |
| P1-02 MCP sözleşmesi | `outputSchema`/`structuredContent`, doğru read/write/destructive annotations, typed errors; legacy text uyumu; desteklenen protokol/istemci matrisi | Schema validation, tools/list/call, hata/iptal, iki gerçek MCP host ve legacy/güncel revizyon test raporu | M/L |
| P1-03 Offline kalite seti | En az 120 TR/EN query; teknik/haber/navigational/genel/araştırma ve adversarial örnekler; bunun en az 40'ı yerel retrieval | Etiketli golden set; ayrı tuning/test bölümleri; nDCG@5, recall@5, MRR, kaynak doğruluğu, tarih/domain uyumu raporu | M |
| P1-04 Live provider benchmark | En az 50 temsilî query; yapılandırılmış sağlayıcılar için limitlere uygun üç ayrı gün/saat ölçümü | Success/no-results/blocked/429/timeout/parser-error ayrımı; p50/p95 ve faydalı top-5 raporu; test ortamı/lokasyon kaydı | M |
| P1-05 Model yaşam döngüsü | Model revision/cache yolu, offline bayrağı, lazy load/warmup, single-flight, kontrollü retry ve açık readiness; bounded embedding queue | Cold/warm RAM/süre ölçümü; modelsiz fallback; ağ kapalı senaryo; restart/resume ingestion davranışı | M |
| P1-06 Sağlayıcı politikası | Scraper'ları deneysel statüyle açıkla; SearXNG JSON doğrulaması; gerekirse kullanıcı seçimine bağlı resmî API adapter'ı | Provider conformance tests, kullanım koşulları/lisans kontrol kaydı, timeout/backoff/fallback deneyleri | M |

Resmî API entegrasyonu opsiyonel olmalı; “API anahtarı gerektirmeyen mod” korunabilir. Belgelenmiş Tavily/Exa yetenekleri özellik kıyasıdır; hiçbir sağlayıcı için ölçüm olmadan kalite veya süreklilik garantisi verilmez.

İlk kabul hedefi önerisi: çift dil test setinde insan değerlendirmesiyle query'lerin en az %80'inde top-5 içinde yararlı kaynak; expansion'ın single-query baz çizgisine göre anlamlı kalite kaybı yaratmaması. Bu oran sektör standardı değil, pilot için önerilen iç hedeftir; ölçüm sonucu yeniden kalibre edilecek. Kaynak/domain filtre ihlali ve cross-user veri sızıntısı için tolerans sıfırdır.

## 5. P2 — Hosted davetli pilot ve kontrollü public beta

P0 + P1 kanıtlarından sonra uygulanır. Sorumlu roller: release/operasyon ve ürün sorumlusu.

1. Staging ortamını production'dan hesap/secret/veri bakımından ayır. Beş ila on davetli pilot kullanıcıyla teknik dokümantasyon ve kaynak araştırması görevlerini doğrula; onboarding süresi, başarısız query türü, yararlı kaynak oranı ve tekrar kullanım ölçülsün.
2. Minimal panel: kayıt/giriş, workspace ve üyelik, MCP bağlantı bilgisi, scope ve credential yönetimi, kullanım/kota, belge ve hafıza görüntüleme/silme/export, servis durumu ve destek yolu. Hassas içerik logging'i varsayılan kapalı olsun; saklama ve işleme politikası onboarding'de açıklansın.
3. SemVer, changelog ve desteklenen MCP protocol/client listesi belirle. Repo planındaki v1.2 adı ile gerçek package/server `1.0.0` numarasını tutarlı hale getir; image ve server kimliği aynı release kaynağından gelsin. Yerel paket desteklenecekse ayrı temiz kurulum matrisi oluştur.
4. Release CI: build/typecheck/unit/schema/security + auth/isolation/load + image scan/Docker HTTP smoke; artifact'ta sır/DB olmaması; dependency/model lisans envanteri ve SBOM. Immutable image digest kullan. npm kanalı yayınlanacaksa OIDC/provenance ekle. [npm yayın modeli](https://docs.npmjs.com/trusted-publishers/), [provenance sınırları](https://docs.npmjs.com/generating-provenance-statements/).
5. Canary deployment ve feature flags; önce davetli küçük kohort. Önceki image'a dönüş, worker drain ve DB migration rollback/forward-recovery yolu gerçek restore denemesiyle doğrulanmalı. Hatalı provider/model/profile hızlı kapatılabilsin.
6. En az yedi günlük hosted pilot sonrasında blocker kalmadığında sınırlı kayıt ve sert kotalarla public beta değerlendir. Alarm/olay müdahalesi, kapasite ve maliyet gözlemi olmadan açık sınırsız kayıt açma. Public beta, GA/SLA taahhüdü değildir.

Hosted beta kapısı: P0 tamam, auth/tenant negatif testleri geçer, kalite ve live provider raporu hazır, hedef istemci/HTTP matrisi geçer, load ve restore testi geçer, egress politikası doğrulanır, yüksek/moderate audit bulgusu yok veya gerekçeli/sona erme tarihli kabul kaydı var, limits ve bilinen sorunlar açıklanmış, incident/rollback sorumlusu belirli. Açık risk kabulü cross-tenant erişim için yayın izni sayılmaz.

## 6. P3 — Public GA ve kapasite büyütme

Public hedef kesin; bu faz beta kanıtlarından sonra GA ve kontrollü kapasite artışını kapsar. Aşağıdaki güvenlik/veri maddeleri P0'da kurulacak, burada operasyon ve ölçek altında tekrar doğrulanacak.

- Hedef protokol revizyonuyla uyumlu HTTP MCP transport, HTTPS ve reverse proxy; authenticated principal; token audience/scopes; güvenli Origin/Host politikası. Yeni revizyon için SDK migration ve legacy istemci stratejisi ayrıca test edilmeli.
- Tenant/user id sunucu tarafından türetilsin. Cache, note, knowledge, graph, browser context ve kota sınırları tenant kapsamında olsun; ortak cache yalnızca açıkça kamuya ait içerik ve belirli politika için kullanılsın.
- Read/write araçları ayrı yetkilensin. İstemcinin verdiği note id/source/session başka kullanıcının verisine erişim sağlamasın. Negatif cross-tenant testleri yayın kapısıdır.
- Shared deployment için DB seçimi load, transaction ve restore kanıtına göre yapılsın. SQLite tek instance private serviste uygun olabilir; replica sayısını artırmak için DB dosyasını ortak volume'a koymak bir ölçekleme stratejisi sayılmasın.
- Queue/worker sınırları, distributed quota, storage/model/browser bütçeleri, readiness/liveness, trace id ve redacted logs; alarm ve incident runbook; yedekleme, restore ve disaster recovery sahibi.
- Public üründe ek olarak abuse/DDoS savunması, veri export/delete süreci, gizlilik/saklama politikası, destek/escalation, maliyet ve varsa faturalandırma. Hukuki ve lisans gereklilikleri hedef pazar/veri kapsamına göre ayrıca değerlendirilir.

Hosted pilot SLI önerileri: uygun isteklerde servis hatasız tamamlama oranı; warm basic search p95; deep ve cold-start ayrı dağılımlar; sonuç veren sorgularda yararlı kaynak oranı; veri restore süresi; request başına provider/model/browser kullanımı. Geçerli boş sonuç ile servis hatası aynı kategoriye alınmaz.

Başlangıç SLO taslağı: warm basic search p95 <= 12 saniye, deep p95 <= 45 saniye, servis tamamlama >= %99,5 / 30 gün; RPO <= 24 saat, RTO <= 2 saat. Bunlar ölçülmüş sonuç veya dış taahhüt değil, baseline ölçümlerinden sonra kesinleştirilecek iç hedeflerdir. Hosted modeller deploy sırasında hazırlanmalı; model indirme normal kullanıcı isteğinin latency'sine yüklenmemeli. [Kullanıcı odaklı SLO yaklaşımı](https://sre.google/workbook/implementing-slos/).

GA kapısı: en az 30 günlük beta SLI/cost kaydı; desteklenen yükte SLO kanıtı; security review ve izolasyon raporu; başarılı restore/incident tatbikatı; kullanıcı verisi silme/export ve credential revocation; gerçek destek/on-call sahibi; planlanan kapasiteye göre load/headroom ölçümü. Bunlar tamamlanmadan uptime/quality SLA satılmamalı. Kesin bütçe ve SLA kullanıcı/iş modeli kararı gerektirir.

## 7. Ertelenen işler ve karar noktaları

Graf genişletme, adaptive provider weighting, otonom çok sayfalı crawler, PDF/OCR, multimodal retrieval, gelişmiş dashboard ve ödeme ilk betanın kritik yolunda değil. Minimal onboarding/usage/veri paneli ve kotalar kritik yoldadır. Diğer özellikler pilotta somut ihtiyaç veya ölçülen retrieval açığı oluşursa tekrar değerlendirilir.

Henüz bilinmeyenler: ilk müşteri segmentinin doğrulanması ve kullanım yoğunluğu, host/protokol beklentisi, veri hassasiyeti, deployment bölgesi, RAM/CPU hedefi, hosting/resmî API bütçesi, sağlayıcıların hedef lokasyondaki performansı ve kullanıcıların ödeme isteği. Public çok kullanıcı hedefi artık kesin; kalan alanlar için karar verilmiş gibi süre veya gelir tahmini yapılmaz.

## 8. İlk uygulanacak sıra

1. Public architecture ADR: protocol/client hedefi, identity/workspace modeli, veri sınıfları, storage/queue adayları ve deployment sınırları; P0-00/00b/00c kabul testleri.
2. P0-01 cache/filter regression ve tenant-aware cache/storage sözleşmesi; tool/service katmanını transporttan ayır.
3. P0-02 hosted veri migration/backup/restore; HTTP/auth/tenant temelini tamamla.
4. P0-03 SSRF/byte cap/egress, P0-04 cancellation/concurrency, P0-05 staging/container ve P0-06 log/silme sınırını doğrula.
5. P1 offline/live kalite seti, schema/protokol uyumu, model hazırlama ve provider politikası; minimal panel/onboarding.
6. P2 hosted davetli pilot -> kotalı public beta -> P3 ölçümle GA; rollback ve incident kapıları her adımda.

Takvim, public mimari prototipi ve ilk benchmark'tan sonra çıkarılmalı. İlk sprintin somut çıktısı hosted mimari kararı, auth/isolation test iskeleti ve cache doğruluk kanıtıdır. MVP'yi internete açmak için mevcut stdio kodunun etrafına yalnızca bir HTTP wrapper eklemek yeterli değildir.
