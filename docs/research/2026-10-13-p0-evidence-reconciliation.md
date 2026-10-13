# P0 uygulama ve kabul kanıtı uzlaştırması — 2026-10-13

**Kaynak revizyonu:** `main` = `b444df1fb5fdaf5928e854ff7f09d5662e3cd640`  
**Amaç:** [production-roadmap.md](../production-roadmap.md) (2 Ekim) ve [development-status.md](../development-status.md) (6 Ekim) içindeki *tarihsel* gözlemlerle 13 Ekim'deki uygulamayı eşleştirmek. Bu, yeni mimari kararı, feature PRD'si veya public-launch onayı değildir.

**Durum sözlüğü:** **Kanıtlandı** = yalnızca belirtilen *alt kapsam* CI ve/veya kaynak kodla gösterildi; **Kısmi** = işin kabul koşullarından bazıları karşılandı; **Açık** = ilgili kalan kabul kanıtı henüz yok. Kapsamın bir alt işi kapandı diye üst P0 veya L3 pilotu tamamlanmış sayılmaz.

## Doğrulanan temel

- `main`: [`b444df1`](https://github.com/kefyusuf/search-memory-mcp/commit/b444df1fb5fdaf5928e854ff7f09d5662e3cd640). [Post-merge CI #38378224695](https://github.com/kefyusuf/search-memory-mcp/actions/runs/38378224695) ve [Docker #38378224716](https://github.com/kefyusuf/search-memory-mcp/actions/runs/38378224716) **SUCCESS**. Docker amd64 smoke ve amd64/arm64 GHCR publish mevcut workflow kapsamında gerçekleşti; bu bir hosted public-lansman kanıtı değil.
- [P0-03 fetch body budget #61](https://github.com/kefyusuf/search-memory-mcp/issues/61) **Closed/Completed**; [kapanış kanıtı](https://github.com/kefyusuf/search-memory-mcp/issues/61#issuecomment-6142977199). HTTP-first [#62](https://github.com/kefyusuf/search-memory-mcp/pull/62), GitHub Raw/RSS [#63](https://github.com/kefyusuf/search-memory-mcp/pull/63), reader [#64](https://github.com/kefyusuf/search-memory-mcp/pull/64), browser terminal routing [#67](https://github.com/kefyusuf/search-memory-mcp/pull/67) ve CDP [#68](https://github.com/kefyusuf/search-memory-mcp/pull/68) birleşti. [Gerçek Chromium 829/829](https://github.com/kefyusuf/search-memory-mcp/actions/runs/38377629133) önceki PR head'inde başarılı; son `main` için normal CI başarılı.
- `package.json` sürümü **1.0.3**. Bu uzlaştırma sürüm veya release oluşturmaz. `main` üzerindeki iki eski deney/tasarım PR'ı [#65](https://github.com/kefyusuf/search-memory-mcp/pull/65) ve [#66](https://github.com/kefyusuf/search-memory-mcp/pull/66) **merge edilmeden kapatıldı**.

## P0 kanıt matrisi

| İş | Doğrulanan alt kapsam | Kalan kabul kapısı | Karar |
| --- | --- | --- | --- |
| P0-00 — Hosted API / identity | İmzalı JWT ve key-ring sözleşmesi, PostgreSQL membership resolver, HTTP auth **callback/factory**, membership audit ve kontrol noktaları; [hosted-http-auth.ts](../../src/runtime/hosted-http-auth.ts), [development-status.md](../development-status.md) | Çalışan public MCP listener/bootstrap, tam OAuth/issuer operasyonu, trusted admin/provisioning, üretim secret/key yönetimi ve dış istemci kanıtı | **Kısmi** |
| P0-00b — Tenant veri sınırı | Memory, knowledge, graph ve private cache erişimlerinde request-context namespace kontrolleri ve negatif testler; [workspace testleri](../../src/__tests__/workspace-cache.test.ts) | Hosted storage migration, tüm kaynaklarda runtime/worker izolasyonu, üretim transaction fencing ve restore/rollback kanıtı | **Kısmi** |
| P0-00c — Kota / abuse | [InMemoryInvocationAdmission](../../src/runtime/invocation-admission.ts) eşzamanlılık + isteğe bağlı process-local sliding-window rate sınırları | Dağıtık/ingress IP ve signup limitleri, total job/provider/cost budget, abuse izolasyonu | **Kısmi** |
| P0-01 — Cache/filter | Exact domain/date kısıtları ve namespace filtrelemesi için regresyonlar; [testler](../../src/__tests__/search-cache-filters.test.ts) | Tüm stratejiler/hosted namespace sınırı ve hedef kalite/kapsam matrisi için uçtan uca kabul kanıtı | **Kısmi** |
| P0-02 — Veri dayanıklılığı | Dört yerel SQLite store'da WAL + FULL sync; [crash/reopen testi](../../src/__tests__/sqlite-durability.test.ts), [backup/restore testi](../../src/__tests__/sqlite-backup-restore.test.ts), `integrity_check` | Hosted DB/storage seçimi, tenant migration, operasyonel backup/restore runbook'u, release rollback ve canlı recovery kanıtı | **Yerel alt kapsam kanıtlandı; P0-02 kısmi** |
| P0-03 — Güvenli fetch | [#61](https://github.com/kefyusuf/search-memory-mcp/issues/61) içindeki **untrusted response body byte-cap** A/B/C kabulü tamamlandı. [guarded-fetch.ts](../../src/security/guarded-fetch.ts) ve [browser-egress-proxy.ts](../../src/security/browser-egress-proxy.ts) bağlantı/IP kontrolü uygular; ilgili testler mevcut | Roadmap'in *daha geniş* SSRF/redirect/subrequest, tüm hosted worker topolojisi ve end-to-end kaynak/timeout kanıtlarını #61 kapanışıyla otomatik tamamlanmış sayma | **#61 kanıtlandı; geniş P0-03 kısmi** |
| P0-04 — İş bütçeleri | KnowledgeIndex per-index pending chunk limiti, embedding provider per-instance single-flight + aktif/bekleyen inference limitleri; [index-store.ts](../../src/knowledge/index-store.ts), [embedding.ts](../../src/cache/embedding.ts) | Uçtan uca deadline/AbortSignal, cross-provider/browser concurrency, expansion provider-attempt toplam bütçesi, forced cancellation/release kanıtı | **Kısmi** |
| P0-05 — Dağıtım | [Dockerfile](../../Dockerfile) iki aşamada **Node 24**; gerçek image smoke ve GHCR amd64/arm64 publish **başarılı** | Hosted staging TLS/secret, production HTTP MCP, persistent volume + backup, readiness/shutdown ve deploy rollback kanıtı | **Container alt kapsam kanıtlandı; P0-05 kısmi** |
| P0-06 — Untrusted veri | [untrusted.ts](../../src/security/untrusted.ts) içerik sarma/temizleme; ilişkili testler ve scoped deletion kontrolleri | Adversarial içerik akış matrisi, log redaksiyon/retention, kalıcı index/graph silme ve operasyonel denetim kanıtı | **Kısmi** |

## Eski risk cümlelerini nasıl okumalı?

- **R2 (SQLite MEMORY journal):** Artık mevcut kodun genel tanımı değil. Store'lar WAL + FULL açılıyor ve gerçek crash/restore regresyon testleri var. Bu, hosted DB operasyonel kurtarma/migration ihtiyacını kaldırmaz.
- **R3 (Docker Node 20):** Güncel Dockerfile her iki aşamada Node 24 kullanıyor. Image smoke ve çoklu mimari yayın başarılı; hosted canlı servis hazır anlamına gelmez.
- **R4 (DNS fail-open iddiası):** `ssrf.ts` içindeki `isPrivateHost`, iki DNS sorgusu da başarısız olduğunda veya birleşik adres kümesi boş kaldığında hostu **reddediyor**. Ancak tek adres ailesinin sorgusu başarısızken diğer aileden yalnızca genel adresler dönerse bu ön kontrol geçebilir. [Guarded lookup](../../src/security/guarded-lookup.ts) yardımcı fonksiyonu resolver hatalarını, boş ve genel olmayan socket adreslerini ayrıca reddeder; **ContentFetcher içine henüz bağlanmamıştır**. Browser tarafındaki proxy sınırları ayrıdır. Tüm SSRF/bağlantı topolojisinin mutlak güvenli olduğu çıkarımı yapılmaz.
- **R5 (arrayBuffer/text sınırsız):** `#61` kapsamındaki HTTP, Raw/RSS, reader ve Chromium ana HTML body tüketimi streaming/byte limit ile düzeltildi; ek subresource ve Chromium process toplam belleği için bir garanti değil.
- **R6 (model/job sınırsız):** Per-index chunk rezervasyonu, provider single-flight ve per-provider inference queue limitleri artık mevcut. Process-geneli ve toplam istek budget hâlâ açık.
- **R1, R7 ve R8:** Eski metinleri otomatik olarak kapatmayın. R1'in kesin filtreleme alt kapsamı düzeltildi; R7 sağlayıcı hata taksonomisi ve R8 hedef MCP istemci/protokol matrisi için bu uzlaştırmada yeni kabul kanıtı üretilmedi.

## Karar ve yalnızca önerilen sonraki iş birimi

**Karar: L3 public pilot = NO-GO (henüz).** Yerel stdio/HTTP auth *factory* kanıtını çalışan, çok kiracılı public ürün kanıtına çevirmeyin. Mevcut tüm P0 numaralarını yeniden başlatmayın; yeşil testlere rağmen yukarıdaki kalan kabul şartları ayrıca sürüyor.

**Sıradaki küçük aday (henüz başlatılmadı):** **P0-02 hosted veri recovery/migration karar kapısı**, yalnızca kanıt/envanter iş birimi. Amaç, mevcut yerel WAL/crash/backup kanıtını baz alıp hosted persistent store, migration/rollback ve tenant-scope restore gereksinimlerinin **hangi** somut eksik kanıtlara sahip olduğunu yazmak. Kabul çıktısı: kaynak/store envanteri, lokal-vs-hosted kanıt farkı, test matrisi ve explicit GO/NO-GO; **bu bir PostgreSQL taşıma, Redis/queue ekleme, deployment veya P0-02 tamamlandı iddiası değildir**. Implementasyon bu ayrı kapının kararından sonra değerlendirilir.

Bu dosya yalnızca kayıtların uzlaştırılmasıdır; eski roadmap bölümleri tarihsel plan/öneri olarak kalır.
