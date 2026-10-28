# ADR-0005: Hosted pilot mimarisi — bootstrap kompozisyonu ve kademeli araç açılımı

Status: accepted (2026-10-27, Faz A+B kapsamı). Supersedes nothing; refines ADR-0002's deferred bootstrap decision and the roadmap P2 pilot preparation.

## Bağlam

Hosted altyapı parçaları (JWT adapter + key ring, PostgreSQL membership resolver + audit, `createHostedHttpAuthHandler` fabrikası, transport-bağımsız `ToolDispatcher`, admission politikası, tenant-scoped store'lar) birer birim olarak mevcut ve CI'da sentetik kabul edildi (TR-03/04/05, ingress e2e, TA-01..07). Ancak production'da dinleyen hiçbir hosted sunucu yok: 12 aracın tamamı `modes: ["local"]`, `onAuthorized` gövdesi boş, provisioning/panel/IdP seçimi yapılmadı. Bu ADR, hosted pilot yolunun ilk implementasyon fazının mimarisini sabitler.

## Kararlar (provisional olanlar uygulanmadan önce değiştirilebilir)

1. **Deployment (provisional): VPS + Docker Compose, tek instance.** SQLite tek-dosya modeli çok instance'ı desteklemez; ölçekleme stratejisi olarak ortak volume planlanmaz (roadmap kuralı). Pilot tek instance ile sınırlıdır.
2. **Uygulama verisi (provisional): paylaşımlı SQLite + scope kolonları.** Mevcut dört store'un `mode|tenant|workspace` modeli TA testleriyle kanıtlandı. pgvector/PostgreSQL migration'ı pilottan sonraki ayrı karardır. Hosted sunucu tek `HOSTED_APP_DB` dosyası kullanır; store instance'ları scope başına önbelleklenir (aşağıda).
3. **Kimlik (issuer pluggable):** hosted sunucu, env ile verilen herhangi bir ES256/RS256/EdDSA issuer'ı kabul eder (JWT adapter sözleşmesi). Gerçek IdP seçimi (yönetilen OAuth önerilir) Faz C öncesi ayrı karardır; bootstrap bu karara bağımlı değildir.
4. **Panel (provisional): minimal** — giriş, workspace listesi, MCP bağlantı bilgisi, token, temel kullanım. Roadmap'in tam panel listesi Faz D.

## Bootstrap kompozisyonu

`src/hosted/server.ts` (env-yapılandırılabilir, `HOSTED_*` değişkenleri, eksik yapılandırmada kurulum talimatıyla çıkış):

```
HTTP listen (HOSTED_HTTP_PORT)
 └─ createHostedHttpAuthHandler          (auth sınırı; Host/Origin/bearer kuralları)
     └─ JwtAuthorizationAdapter          (env issuer/audience/key; PostgresMembershipResolver — canlı, asla restore edilmez)
         └─ onAuthorized(req, res, context)
             └─ stateless SDK MCP transport  (istek başına McpServer)
                 └─ ToolDispatcher[admission]  (12 isim kayıtlı; hosted üçü aktif)
                     └─ TenantStoreCache       (scope başına SessionMemory, LRU)
```

- **TenantStoreCache:** `mode|tenant|workspace` başına bir `SessionMemory`, lazy açılış, LRU tahliyesi (`HOSTED_MAX_TENANT_STORES`, tahliye edilen close). Node tek iş parçacığı + better-sqlite3 senkron olduğundan evict/use yarışı yapısal olarak imkânsızdır.
- **Kademeli araç açılımı:** ilk dilim `remember/recall/forget` (`modes: ["hosted"]`). Diğer dokuz isim `modes: []` ile kayıtlıdır — çağrı `execution_mode_unavailable` döner; clients tüm kataloğu görür. Sıradaki dilimler `web_search`/`fetch_content` (süreç-geneli kaynaklar — health tracker, limiter, tarayıcı — tenant verisi taşımadığından paylaşılabilir) sonra knowledge araçlarıdır.
- **Admission:** `InMemoryInvocationAdmission`, limitler env ile **açıkça** verilir (ADR-0002 kuralı); rate limitler sonraki dilim.
- **Local stdio yolu değişmez:** `src/index.ts` bu fazda düzenlenmez; hosted kayıtlar `src/hosted/server.ts`'te yaşar.

## Süreç-geneli / tenant-bağlı kaynak ayrımı

| Kaynak | Kapsam | Gerekçe |
| --- | --- | --- |
| Search providers, health tracker, token bucket'lar | Süreç-geneli | Motor engellenmesi/yavaşlığı tenant verisi taşımaz; servis düzeyi korumadır |
| Chromium + egress proxy, ContentFetcher | Süreç-geneli | Tenant verisi content cache'te değil; cache hosted diliminde tenant-scoped instance ile değişir |
| Embedding/intent/rerank modelleri | Süreç-geneli | Paylaşımlı çıkarım; girdi çıktısı tenant etiketli değildir |
| SessionMemory / KnowledgeIndex / EntityGraph / SQLiteVectorStore | **Tenant-bağlı** | Veri izolasyonu construction-bound |
| SearchTraceHistory, server_status | Süreç-geneli (bu dilimde hosted'a açılmaz) | Tenant kırılımı olmayan istatistik; hosted'a açılım sonraki dilim |

## Güvenlik ve kapı sınırı

- **Gerçek kullanıcı verisi bu fazda işlenmez.** Doğrulama yalnızca sentetik fixture ile yapılır; davetli pilot açılmadan önce D2-E1–E5 tatbikatı ve gerçek-ortam D3/D4 karşılıkları ayrıca sağlanır (kapılar OPEN).
- `ingest_document`'ın dosya-sistemi dalı hosted'a açılmaz (`allowedDirs` süreç-yerelidir); hosted diliminde `path` kullanımı reddedilir.
- Admission/rate policy env ile açıktır; secret'lar repoya girmez; membership DB'si canlı otoritedir ve asla restore edilmez.
- Kapı durumları değişmez: D2-E1–E5, D3-V3/V4, D4 gerçek karşılıklar OPEN; TR-02 HOLD; **P0-02 kısmi; public L3 NO-GO**.

## Consequences

- Hosted bootstrap ilk kez gerçek bir dinleyiciyi kompoze eder; bu, public pilot onayı değildir — staging/D2-E tatbikatı ayrı kapılardır.
- Kademeli araç açılımı, her dilimin kendi sentetik kabulünü üretmesini sağlar (ingress e2e deseni genişletilerek).
- Provisioning/admin API (Faz C), minimal panel (Faz D) ve IdP seçimi ayrı onaylı iş birimleridir.
