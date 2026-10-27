# P0-02 — D4 güvenli aktivasyon/fencing kabul tasarımı (uygulama değil)

**Tarih:** 2026-10-27 · **Kaynak `main`:** [`ca50543`](https://github.com/kefyusuf/search-memory-mcp/commit/ca50543) · **Durum:** DESIGN-ONLY / HOSTED NO-GO
**Durum güncellemesi (2026-10-27):** TA-01…TA-07 **uygulandı ve SYNTHETIC PASS** — [PR #105](https://github.com/kefyusuf/search-memory-mcp/pull/105), npm `test:activation-fencing` + CI adımı (8 checks; canlı PostgreSQL + restore edilmiş hedef üzerinde revizyon-tutarlı çift restore, uyuşmazlık/yarım-restore/onay-redleri fail-closed, kayıtlı aktivasyon, tek etkin veri yolu, otomatik geri dönüş yok). **Gerçek cutover, deployment, hosted handler'lar ve L3 NO-GO** değişmez.

## Karar sınırı

Bu belge, [yetki/kapsam kapısındaki](2026-10-13-p0-02-recovery-authority-scope-gate.md) **D4-A1–A5 kanıt ihtiyaçlarını** sentetik kabul senaryolarına çeviren **tasarım iş birimidir** — [restore/revocation test tasarımının](2026-10-13-p0-02-restore-authorization-test-design.md) doğrudan devamı ve son parçası.

**Dahil:** sentetik aktivasyon harness tasarımı, fencing değişmezleri, negatif senaryolar, öncüller ve kanıt kaydı kuralları.
**Hariç:** TypeScript/test kodu (ayrı onaylı PR'da), production cutover mekanizması veya seçimi, deployment, hosted built-in handler'ların açılması, gerçek trafik/veri, release ve public L3.

## Öncüller (2026-10-27 itibarıyla sağlananlar)

- **D2 OPERATOR WORKFLOW APPROVED** ([karar kaydı](https://github.com/kefyusuf/search-memory-mcp/issues/83#issuecomment-6425870367)): roller, bağlayıcı onay (yedek SHA-256 + boş hedef + revizyon, 7 gün), erişim/iptal kaynağı, bağımsız kayıt kanalı.
- **TR-03/TR-04/TR-05 SYNTHETIC PASS** ([PR #100](https://github.com/kefyusuf/search-memory-mcp/pull/100)): canlı otorite + restore edilmiş hedef üzerinde stale-token reddi, audit kanıtı, fail-closed otorite kaybı, bozuk hedef reddi, scope izolasyonu, forged-context reddi.
- **Hosted ingress e2e** ([PR #102](https://github.com/kefyusuf/search-memory-mcp/pull/102)): auth → admission → tenant-scoped store zinciri uçtan uca; HTTP katmanı revocation; erişilemez otoritede 503.
- **Hâlâ yok (bu tasarımın konusu):** iki bağımsız deposun (SQLite uygulama + PostgreSQL identity) **birlikte, revizyon-tutarlı** restore'unun doğrulanması; bir aktivasyon kararının kayda bağlanması; **tek etkin veri yolu** fencing'i.

## Hedef değişmezler (D4 kapılarıyla birebir eşleşir; bugün kanıtlanmış sayılmaz)

**I-A1 — Hedef kimliği ve izolasyon:** her aktivasyon denemesi; yedeğin SHA-256 kimliği, restore öncesi doğrulanmış boş hedef kimliği ve hedef revizyonu **tek işlem referansına** bağlıdır. Hedef yalnızca yetkili doğrulama erişimine açıktır; doğrulama dışında hosted uygulama trafiğine/yazımına kapalı kalır.

**I-A2 — Bütünlük ve tenant sınırı:** uygulama (SQLite) ve identity (PostgreSQL) restore'ları **revizyon-tutarlı** kabul edilmeden hedef doğrulanmış sayılmaz. Yarım/bozuk/eksik backup, revizyon uyuşmazlığı veya A1/A2/B1 sahiplik ihlali hedefi reddeder. D3 güncel yetki kanıtı (restore edilmemiş otoriteden) ayrıca zorunludur.

**I-A3 — Ayrı yayın kararı:** D2'nin o talep/yedek/hedef için geçerli onayı + D3 kanıtı + bağımsız doğrulama çıktısı + **aynı değişmemiş hedef/revizyon** için verilmiş go/no-go kararı birbirine bağlanır; dördünden biri eksikse aktivasyon yoktur.

**I-A4 — Tek etkin veri yolu:** geçiş senaryosunda eski kaynak ve yeni hedef **asla aynı anda yetkili hosted okuma/yazma kaynağı olmaz**. Sentetik harness'ta "etkin yol", hosted bağlamın hangi depo kümesine bağlandığıyla ölçülür; eski kaynaktaki stale token'lar yeni yetkiyi aşamaz.

**I-A5 — Hata ve tekrar:** beş enjeksiyon fazı (restore öncesi, restore sırasında, doğrulamada, aktivasyon öncesi, belirsiz kesit sonrası) ayrıştırılır; her fazda **aktif kaynak korunur, hedef kapalı kalır**; otomatik eski-snapshot'a dönüş veya kontrolsüz tekrar yayın yoktur.

## Sentetik aktivasyon matrisi (uygulamada TA-01…TA-07 olarak açılacaktır)

Fixture, TR-03/04/05 ile aynıdır: tenant A→A1/A2, tenant B→B1; `alice` S0'da aktif/S1'de iptal; `bob` B1'de aktif; aynı cache URL/doc-id/arama terimi her scope'ta; canlı PostgreSQL authority **asla restore edilmez**; A2 için ayrı bir *identity restore kopyası* yalnızca doğrulama nesnesi olarak kullanılır (otorite değildir — D3 kuralı).

| ID | Test girişi / eylem taslağı | Zorunlu olumlu ve olumsuz kanıt | Karşılık |
| --- | --- | --- | --- |
| TA-01 | Uygulama (SQLite S0) ve identity (S0 kopyası) restore'larını **eşleşen revizyon etiketiyle** boş izole hedefe uygula; bütünlük + tenant sahiplik + canlı-otorite yetki doğrulaması | Hedef "verified" durumuna geçer; yayımlanmaz; A1/A2/B1 sahiplik kontrolleri geçer; `integrity_check` + `foreign_key_check` geçer | A2 |
| TA-02 | Revizyon uyuşmazlığı: SQLite S0 + identity **S1** (veya tersi) | Hedef reddedilir: doğrulama başarısız, hosted erişim verilmez, aktif kaynak korunur | A2 |
| TA-03 | Yarım SQLite restore + tam identity restore | Fail closed: hedef kullanılamaz sayılır; B1 ve aktif kaynak etkilenmez | A2/A5 |
| TA-04 | TA-01'in doğrulanmış çıktısı + D2 biçimli onay kaydı (yedek SHA-256 + boş hedef + revizyon) + D3 kanıtı → **aktivasyon kararı kayda geçer** | Yalnız bu durumda hosted bağlam hedef depo kümesine bağlanabilir (sentetik "activated" bayrağı); onay/hedef/revizyon uyuşmazlığında bağlanmaz | A3 |
| TA-05 | Aktivasyon sonrası: eski kaynak üzerinde yazım + stale token erişim denemesi | Eski kaynak yeni yetkiyi aşamaz; stale token hedefte de reddedilir; tek etkin veri yolu korunur | A4 |
| TA-06 | Cutover sonrası belirsizlik: yarım doğrulama/kesintiye uğramış aktivasyon kaydı | Otomatik geri dönüş **yok**; yeni onay + yeniden doğrulama gerekir; her iki tarafın durumu kayda geçer | A5 |
| TA-07 | Aktivasyon öncesi hata enjeksiyonu (her fazda) | Aktif kaynak değişmez; hedef kapalı kalır; kaynak durumu kayda geçer | A5 |

## Sentetikte "aktivasyon"ın tanımı ve seçilmeyenler

Sentetik harness'ta aktivasyon, **harness içi bir bağlama geçişi**dir: doğrulanmış ve onaylı hedef depo kümesine hosted bağlam bağlanabilir hale gelir. Üretim cutover mekanizması (trafik yönlendirme, router, lock, ikinci aktif ortam, otomatik failover) **bu tasarımda seçilmez**; D4-A4'ün "tek etkin veri yolu" değişkeni sentetikte bağlama düzeyinde ölçülür. RPO/RTO, retention, backup şifrelemesi ve gerçek DR tatbikatı ayrı işlerdir.

## Kanıt kaydı kuralları

[Uygulama deseni](2026-10-13-p0-02-restore-authorization-test-design.md) ile aynıdır: **ayrı, onaylı** sentetik test PR'ında her TA-ID için gerçek komut/test kimliği, hedef revizyon, expected/actual, CI bağlantısı ve failure-injection sonucu kaydedilir; [yetki/kapsam kapısının](2026-10-13-p0-02-recovery-authority-scope-gate.md) D4 bölümüne yalnızca durum + referans yansıtılır.

## PASS / GO / NO-GO

**PASS (yalnızca tasarım):** bu tek Markdown dosyasının bağımsız incelemesi + exact-head CI. **GO:** tasarım kabulünün ardından TA-01…TA-07 sentetik test implementasyonu **ayrı bir PR'da** yetkilendirilir (TR-03/04/05'te izlenen desen). **NO-GO:** gerçek cutover, deployment, hosted built-in handler'ların açılması, storage migration'ı, R-B/TR-02, release ve public L3 — bunlar bu tasarımın kapsamı dışında ve onaysızdır. **D3–D4'ün sentetik kanıtı, hosted pilot veya L3 için yeterli sayılmaz.**
