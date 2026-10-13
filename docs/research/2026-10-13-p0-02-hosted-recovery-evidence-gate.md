# P0-02 — Hosted veri dayanıklılığı / kurtarma kanıt kapısı

**Tarih:** 2026-10-13 · **Kaynak `main`:** [`2be343d`](https://github.com/kefyusuf/search-memory-mcp/commit/2be343d7bf935783573ff0638fb78e4e5ae54383) · **Durum:** **EVIDENCE-ONLY / NO-GO (hosted migration veya public deployment için)**

## Sınır ve karar

Bu belge [P0 durum uzlaştırmasındaki](2026-10-13-p0-evidence-reconciliation.md) **P0-02 adayının ilk ve tek envanter/kanıt iş birimidir**. Mevcut kaynakları inceleyip kanıt boşluklarını ve ileride gerekli testleri tanımlar. **PostgreSQL'i ana veri deposu olarak seçmez**; SQLite'ı hosted shared DB olarak onaylamaz; migration, backup komutu, deployment, otomatik restore, tenant export, yeni servis/queue veya uygulama kodu eklemez. Buradaki test matrisi **yapılmış testlerin listesi ile henüz yapılmamış test gereksinimlerini ayrı gösterir**.

**GO:** Bu envanter, sonraki *ayrı* tasarım/kanıt kararının girdisi olabilir.  
**NO-GO:** Hosted veri migration'ını başlatmak, çok tenant'lı restore garantisi vermek, L3 public pilot açmak veya P0-02'yi kapatmak için kanıt **yetersiz**.

## Gerçek kalıcı durum envanteri

| Yüzey | Güncel gerçek | Korunması gereken ayrım / eksik |
| --- | --- | --- |
| Yerel dosya yolu | [`resolveCacheDbPath`](../../src/runtime/db-path.ts) önce `CACHE_DB_PATH`, sonra mevcut legacy çalışma dizini dosyası, yoksa kullanıcı ana dizini altındaki `.search-memory-mcp/websearch_cache.db` yolunu seçer | Kaynak DB yolunun envanteri, eski yol önceliği ve sahipliğinin migration öncesinde doğrulanması gerekir |
| SQLite içerik ve semantic cache | [`SQLiteVectorStore`](../../src/cache/sqlite-store.ts): content cache, semantic metadata, native vector ve JS fallback; trusted mode/tenant/workspace sınırları | Önbellek *disposable* kabulü tüm veriler için otomatik değildir; yeniden oluşturulabilirlik/veri saklama kararı ayrıca gerekir |
| SQLite knowledge | [`KnowledgeIndex`](../../src/knowledge/index-store.ts): belge, chunk, FTS, isteğe bağlı embedding vektörleri ve scope anahtarları | Belge/chunk ile sonradan işlenen embedding işi farklı anda tamamlanabilir; tutarlı uygulama snapshot'u için işlerin durması/`flush()` gerekir |
| SQLite memory | [`SessionMemory`](../../src/memory/session-memory.ts): kullanıcı notları ve session/topic/tags; scope-temelli CRUD | Kullanıcıya ait içerik kaybı, migration doğrulaması ve tenant-scoped kurtarma kabulü olmadan kabul edilemez |
| SQLite graph | [`EntityGraph`](../../src/graph/entity-graph.ts): belge, entity ve link tabloları; trusted scope ve yerel legacy schema dönüşümü | Knowledge ile graph ayrı transaction'lara sahip olabilir; çapraz-store uygulama tutarlılığı ayrıca test edilmeli |
| Çalışan local MCP | [`src/index.ts`](../../src/index.ts) bu dört store'u **aynı** çözümlenen SQLite dosya yolu ile oluşturur; bağlantılar/store sınıfları ayrıdır | Tek dosyalık **fiziksel** backup bütün tablo/scope'ları taşır; tenant bazlı restore/export değildir |
| Hosted identity prototipi | [SQL migration 0001](../../migrations/0001-hosted-membership.sql): PostgreSQL workspace + membership, [0002](../../migrations/0002-hosted-membership-audit.sql): transaction-bound audit; [Postgres verifier](../../scripts/verify-membership-postgres.mjs) ve [audit verifier](../../scripts/verify-membership-audit.mjs) | Bu PostgreSQL ayrı bir **kimlik read-model prototipidir**; memory/knowledge/graph/cache PostgreSQL'e taşınmadı. Membership/audit için fiziksel backup/restore ve uygulama DB'siyle koordinasyon kanıtı **yok** |
| Container persistent path | [Dockerfile](../../Dockerfile) içinde `CACHE_DB_PATH=/app/data/websearch_cache.db`; [docker-compose.yml](../../docker-compose.yml) `websearch-data` volume bağlar; model indirme önbelleği için ayrı `websearch-models` volume vardır | Image smoke/GHCR publish, volume backup/restore veya real hosted data durability kanıtı değildir. Model cache'in restore/rebuild politikası ayrı tanımlanmalı |

**Ortak SQLite politikası:** Bu dört store dosya bağlantılarında `journal_mode=WAL` ve `synchronous=FULL` ister. In-memory SQLite'da WAL beklenmez. WAL sidecar dosyalarını yok sayıp aktif `.db` dosyasını kopyalamak güvenilir backup yöntemi değildir.

## Mevcut kanıtın sınırı

- [Crash/reopen testi](../../src/__tests__/sqlite-durability.test.ts) — **VAR:** kontrollü child process `SIGKILL`, daha önce commit edilmiş notun korunması, commit edilmemiş replacement'ın geri alınması, cache/knowledge/graph'un yeniden okunması, `integrity_check` ve yeniden açılışta WAL doğrulaması. **YOK:** elektrik kesintisi, ağ dosya sistemi, distributed writer, storage-failure testi veya hosted DR tatbikatı.
- [Backup/restore testi](../../src/__tests__/sqlite-backup-restore.test.ts) ve [prosedür açıklaması](../sqlite-backup-restore.md) — **VAR:** kaynak yazımları durdurulmuşken `KnowledgeIndex.flush()`, SQLite Online Backup API, yeni ve bağımsız restore dosyası, WAL negative-control, dört store üzerinden veri ve vektör/FTS/graph doğrulaması, `integrity_check` + `foreign_key_check`. **YOK:** eşzamanlı aktif producer altında uygulama-geneli atomiklik, canlı DB üzerine restore, tenant-özel restore, encryption, retention, disaster recovery zamanı.
- [Hosted membership/audit SQL doğrulamaları](../hosted-membership.md) — **VAR:** farklı PostgreSQL rollerinin erişim sınırları, transaction/audit rollback ve membership okuma testleri. **YOK:** physical/point-in-time PostgreSQL recovery, revocation sonrası restore/fencing, uygulama SQLite durumu ile tutarlı ortak restore.
- [P0 kabul uzlaştırması](2026-10-13-p0-evidence-reconciliation.md) ve [production roadmap](../production-roadmap.md) — hosted backup, tenant migration/rollback ve restore operasyonları halen ayrı blokajlardır. **Yeşil genel CI**, eksik hosted senaryoların çalıştırıldığı anlamına gelmez.

## Henüz çalıştırılmamış kabul testleri / karar matrisi

| Senaryo | Bugün kanıt | Hosted uygulama öncesi gereken kanıt |
| --- | --- | --- |
| 1. Yerel commit ve WAL sırasında process kill | **VAR** (kontrollü fixture) | Desteklenen runtime/volume koşullarına genişletme kararı; bu test tek başına hosted GO değildir |
| 2. Yerel dosyanın tutarlı backup'ı ve boş dosyaya restore | **VAR** (quiesced kaynak) | Üretim prosedürü, restore sahibinin yetkisi ve tekrarlanabilir bağımsız hedef kanıtı |
| 3. Aynı dosyadan farklı tenant'ların tekil geri yüklenmesi | **YOK** | Tenant A restore işleminde B'ye ait kayıtların okunmaması/değişmemesi; scoped backup/export modelinin ayrıca seçilip test edilmesi |
| 4. Legacy local schema → hosted veri şeması | **YOK** | Veri/scope/ID eşleme ve reversible-safe migration planı, duplicate/partial-write idempotency, rollback ya da forward-recovery testi |
| 5. Knowledge belge/embedding + graph atomik geri yükleme | **YOK** | Pending inference drain, cross-store consistency ölçümü, eksik vector/graph referansları için fail-closed veya açık rebuild politikası |
| 6. PostgreSQL identity + audit'in ayrı ortamda restore edilmesi | **YOK** | Membership/audit tutarlılığı, migration sıralaması, roller/ACL, aktif credential ve revocation durumları için doğrulama |
| 7. Restore sırasında erişim yetkisi gerilemesi / revocation | **YOK** | Eski yedeğin restore'u iptal edilmiş yetkileri istemeden diriltmemeli; policy/fencing ve audit bütünlüğü kararı gerekir |
| 8. Container volume kaybı / yeni node'a geri yükleme | **YOK** | Volume snapshot, mount izinleri, startup/readiness, backup storage erişimi ve doğrulanabilir empty-host recovery |
| 9. Yarıda kesilmiş backup, dolu disk, bozuk image | **YOK** | Kesinti/arıza enjeksiyonu, cleanup ve integrity doğrulaması, orijinal aktif DB'nin korunması |
| 10. Veri saklama/şifreleme ve RPO-RTO ölçümü | **YOK** | Ürün/sorumlu tarafça **sayısal RPO/RTO hedefleri** kararlaştırılmalı; backup şifreleme, erişim, retention ve gerçek restore zamanı ölçülmeli |

**Kritik doğruluk kuralı:** Her SQLite tablosunda execution mode/tenant/workspace kolonları bulunması, **fiziksel veritabanı yedeğinin tenant izolasyonlu olduğu** anlamına gelmez. Restore edilen eski membership/audit ve kullanıcı verisinin birlikte güvenli kullanımı ayrıca tasarlanmalıdır. Testler gerçek çok-kiracılı veriler yerine disposable sentetik fixture kullanmalıdır.

## Ayrı karar gerektiren fakat burada alınmayan seçimler

1. Veri sınıfları: kullanıcıya ait/korunması zorunlu veri ile onaylı yeniden üretilebilir cache/model artefaktlarının sınıflandırılması; hukuki retention ve deletion beklentileri.
2. Deployment topolojisi ve source of truth: local/private tek instance mı, shared hosted mı; PostgreSQL/başka depolama seçimi **kanıta bağlı**.
3. RPO/RTO, backup sıklığı, anahtar/secret yönetimi, restore yetkilisi ve tatbikat sahibi: **henüz tanımlı değil**.
4. Migration geri dönüş sınırı: schema upgrade öncesi/veri taşıma sonrası rollback'in ne zaman güvenli olduğu; otomatik eski sürüme dönülebilir varsayılmamalı.
5. Tenant-scoped restore ve identity revocation: explicit yetki/fencing politikası olmadan hosted import/export açılmamalı.

## Sonraki güvenli sınır

**Bu iş biriminin tamamlanma ölçütü:** kaynak envanteri + yerel/hosted kanıt ayrımı + eksik test matrisi + açık **NO-GO** kararı içeren yalnızca bu Markdown dosyasının bağımsız incelemesi ve dokümantasyon CI doğrulaması. **Bu PR'ın merge edilmesi P0-02 implementation yetkisi veya hosted pilot onayı değildir.**

**Bir sonraki olası ayrı iş (açılmadı):** Yetki/restore gereksinimlerini doğrulayan *P0-02 test tasarımı kapısı*. Depolama adapter'ı, migration SQL, backup aracı veya dağıtım çalışması ancak bu kapının kabulüne ve ayrı kapsam kararına göre açılabilir.
