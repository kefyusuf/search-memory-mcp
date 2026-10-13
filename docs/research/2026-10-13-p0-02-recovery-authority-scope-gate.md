# P0-02 — Recovery kapsamı ve güncel yetki otoritesi karar kapısı

**Tarih:** 2026-10-13 · **Kaynak `main`:** [`8f89bdf`](https://github.com/kefyusuf/search-memory-mcp/commit/8f89bdf071a426d7202da6940fa6584e547377af) · **Durum (2026-10-13 D1 kapsam güncellemesi):** **D1 yalnızca ilk pilot kapsamı için kararlaştırıldı / D2–D4 OPEN / P0-02 ve L3 NO-GO**

## Amaç ve sınır

Birleşen [P0-02 kanıt envanteri](2026-10-13-p0-02-hosted-recovery-evidence-gate.md) ile [restore/revocation test tasarımı](2026-10-13-p0-02-restore-authorization-test-design.md) arasında **ürün gereksinimi** ile **gelecekte test edilebilecek özelliği** ayırır. Özellikle, çok kiracılı **tam ortam felaket kurtarması** ihtiyacı ile **tek tenant/workspace seçilerek geri yükleme** özelliği aynı şey değildir.

[Production roadmap](../production-roadmap.md) P0-02 için storage-aware backup ve **boş ortama restore** kanıtı, P0-00b için tenant migration/restore yalıtımı ister; ilk public pilot için kullanıcıya sunulan tenant-seçmeli restore endpoint'i veya UI şart koşmaz. Bu ayrım için **D1 ilk pilot kapsamı** aşağıda kararlaştırılmıştır; bunun dışında restore yetkisi, teknik uygulama ve yayın onayı verilmez.

**Yalnızca bu iş biriminde:** dört karar sorusu, seçenek/sınır, asgari güvenlik koşulları ve gelecekteki kanıt bağımlılığı. **Yok:** uygulama/test/SQL, veritabanı veya cloud seçimi, operatör kimliği açma, backup komutu, endpoint, Docker/CI/config, maliyet taahhüdü, migration, release ve public deployment.

## Doğrulanmış mevcut sınır

- [Yerel SQLite backup/restore](../sqlite-backup-restore.md), dört store'un aynı dosyadaki *bütün* scope'larını taşır ve yalnızca yazımları durdurulmuş lokal fixture'ı bağımsız hedefe açmayı kanıtlar. Tenant export ve hosted recovery değildir.
- [PostgreSQL membership read model](../hosted-membership.md), aktif/grant/revoked üyeliği sorgular, ancak identity verisi ayrı depoda ve bu prototipin point-in-time restore'u test edilmedi. [Transaction-bound audit](../hosted-membership-audit.md) aynı identity işleminin değişim kaydını tutar; farklı yedek tarihlerinde güncel yetkiyi garanti eden *bağımsız otorite* değildir.
- [Request context](../../src/runtime/request-context.ts) ve [hosted HTTP auth factory](../../src/runtime/hosted-http-auth.ts) geçerli yetkilendirme bağlamına ilişkin mevcut sınırları gösterir. Üretim hosted bootstrap, operatör restore kontrolü ve kimlik ile veri arasında atomik restore/fencing bulunmaz.
- [Membership SQL izinleri](../../migrations/0001-hosted-membership.sql) arama/içerik/knowledge/memory/status/cache için tanımlıdır; **restore yönetimi için public MCP izni** veya kullanıcıya açık restore akışı içermez.

## Karar durumu — yalnızca D1 planlama kapsamı kararı

| ID | Karar sorusu | Kapsamı küçük tutan yaklaşım | Durum ve yürütme sınırı |
| --- | --- | --- | --- |
| D1 — Restore granülerliği | İlk pilotta boş ortama tam çevre recovery yeterli mi, tenant/workspace seçmeli restore ayrı ürün gereksinimi mi? | İlk hosted pilotun **hedef kabul kapsamı R-A: ayrı/boş hedefe tam ortam kurtarması**. **R-B: tenant/workspace-seçmeli restore HOLD**, doğrulanmış müşteri gereksinimi doğmadan başlatılmaz. Fiziksel backup hiçbir zaman tenant export olarak sunulmaz. | **D1 SCOPE DECIDED (planlama):** Gerekli hosted kanıt henüz YOK. D2–D4 ve ayrı implementation/test onayı olmadan bu karar yürütme yetkisi değildir. |
| D2 — Restore yetkisi | Restore isteğini, onayını, yürütmesini, doğrulamasını ve yayına almayı kim yetkilendirir? | İstek, onay, başlatma, doğrulama ve aktif hale getirme sorumlularını **güvenilen operasyon yolu** kapsamında açıkça belirleyin; mevcut kullanıcının `memory:write` / `cache:manage` gibi tool izinlerini restore yetkisine yükseltmeyin. İnsan onayı/rol akışı henüz tasarlanmadı. | D2 **OPEN**. Canlı veri restore işlemi veya dışa açık araç devreye alınamaz. |
| D3 — Restore sonrası geçerli yetki | Eski identity yedeğinden dönüşten sonra revocation ve grant azaltmanın güncel otoritesi nasıl korunur? | Eski identity backup'ının yeni revocation/grant azaltma kararlarını geri almadığı **bağımsız biçimde kanıtlanmalı**. Güncel yetkinin nereden ve hangi rollback sınırının dışından doğrulanacağı ya da nasıl uzlaştırılacağı henüz seçilmedi. Sadece eski audit snapshot'ı veya yeni restore edilmiş membership satırını yeterli saymayın. | D3 **OPEN**. Restore edilmiş ortamda hosted erişim **fail closed** kalmalıdır. |
| D4 — Yayına alma / hata sınırı | Restore hedefi hangi doğrulama, fencing ve geri dönüş koşullarında etkin hale getirilebilir? | Önce izolasyonlu hedef ve bütünlük/tenant sahiplik/yetki doğrulaması; aktif hedefe geçiş, erişim durdurma, yeniden deneme ve hata halinde kaynak koruma kuralları **ayrı** tanımlanmalı. Mevcut iki DB'nin atomik snapshot/restore'u kanıtlanmadı. | D4 **OPEN**. Üretim veri yoluna restore hedefi bağlanamaz. |

## D1 karar kaydı — yalnızca ilk pilotun kabul kapsamı

**Seçim:** İlk hosted pilotun P0-02 kurtarma kabul hedefi **R-A: uygulama verisi ve ayrı identity/audit deposu için güvenli, boş ve yalıtılmış ortamda tam kurtarma senaryosudur**. Bu, teknik depolama mimarisi, iki bağımsız deponun atomik restore yöntemi veya tamamlanmış DR tatbikatı seçimi değildir.

**Kapsam dışı / HOLD:** Tek tenant/workspace seçerek import, restore, export, silme/rollback UI veya yeni MCP tool'u ilk pilotun gerekli özelliği sayılmaz. Gelecekte doğrulanmış müşteri ihtiyacı, maliyet/fayda ve ayrı izinli iş birimi bulunursa D1 revize edilebilir.

**Neden:** [Roadmap'in P0-02 kabulü](../production-roadmap.md) storage-aware backup ve **boş ortama restore** ispatı ister. Yerel [SQLite fiziksel prova](../sqlite-backup-restore.md) ise tüm scope'ları aynı dosyayla taşır ve hosted yetki/kimlik geri yüklemesi değildir. Tenant-seçmeli özelliği erken seçmek, bu eksikleri çözmeden yeni migration/authorization yüzeyi ekler.

**D1'in çözmediği zorunlu kapılar:** D2 güvenilir operatör ve onay sorumlusu; D3 restore sonrası güncel revocation/grant otoritesi (eski yedeğe bakmak yeterli değildir); D4 yalıtılmış hedefte bütünlük, cross-tenant doğrulama ve fail-closed aktivasyon. Sayısal RPO/RTO, retention ve backup güvenliği ayrıca belirlenmelidir. Bunların hiçbiri bu kapsam kararıyla PASS olmaz.

**Uygulama izni:** **YOK**. Mevcut hosted built-in handler'lar açılmaz, DB/tenant restore kodu veya test altyapısı eklenmez. TR-01–TR-05 bu karar yüzünden çalıştırılmış sayılmaz. **P0-02 ve public L3 NO-GO** sürer.

## Ayrı ele alınması gereken iki senaryo

**R-A — Tam ortam felaket kurtarması (ilk hedef adayı):** Tüm scope'ların aynı fiziksel imajda yer alması beklenebilir, ancak backup ve hedef yalnızca yetkili operatöre açık olmalıdır. Canlı trafiğe dönmeden önce veri bütünlüğü, cross-tenant isolation, identity/audit ile güvenli yetki uzlaştırması ve bozulmuş/eksik backup'ta fail-closed kanıtı gerekir. Bu senaryo **D1 kapsamında ilk pilot için hedeflenen kurtarma granülerliğidir**; henüz uygulanmış veya hosted ortamda yeterli şekilde test edilmiş değildir. D2–D4 çözülmeden restore yayımlanmaz.

**R-B — Tek workspace/tenant restore (ayrı özellik adayı):** Başka workspace/tenant kayıtları zarar görmeden yalnızca istenen alanın tutarlı taşınması, ID eşlemesi, belge/chunk/graph bütünlüğü ve yetki modelinin ayrı tasarımı gerekir. [TR-02](2026-10-13-p0-02-restore-authorization-test-design.md) gelecekteki kabul tasarımıdır; **D1 kararıyla R-B ilk pilot kapsamı dışında HOLD** durumundadır. Yalnızca doğrulanmış müşteri/iş gereksinimi ve ayrı kapsam kararıyla yeniden açılabilir.

## Kanıt eşlemesi ve durdurma koşulları

| Kaynak kabul maddesi | Bu kapının yapacağı | Henüz yapılmayan |
| --- | --- | --- |
| [TR-01](2026-10-13-p0-02-restore-authorization-test-design.md) fiziksel backup/scope | R-A ile R-B farkını açık tutar | Çok-scope restore fixture'ı **NOT RUN** |
| TR-02 selective A1 restore | D1 kapsam kararıyla ilk pilot için **HOLD**; ancak doğrulanmış müşteri ihtiyacı ve ayrı onayla gündeme alınır | Tenant-selective API/restore testi **NOT RUN** |
| TR-03 revocation geri gelmemesi | D3 için bağımsız güncel yetki kanıtını **zorunlu ön koşul** yapar | Restored PostgreSQL + application DB birlikte test edilmedi |
| TR-04 bozuk/yarım restore, otorite erişilemiyor | D2/D4 fail-closed ve publish-onayı sınırını ister | Hosted failure injection **NOT RUN** |
| TR-05 forged/local context | Hosted'ın trusted local context'e geri düşmesini yasaklayan sınırı korur | Hosted restore-specific test **NOT RUN** |

**Sabit güvenlik koşulu:** Recovery başarısı, auth check'in yalnızca restore edilmiş eski snapshot'a karşı geçmesi demek değildir. Geçerli iptal/ownership kararları doğrulanamıyorsa veya cross-tenant erişim sınırı kanıtlanamıyorsa veri sunulmaz. Bütünlük kontrolü, güncel yetki ispatı yerine geçmez. Identity/tenant geçmişinin nasıl korunduğuna dair çözüm **bu belgede seçilmez**.

**Ayrı açık işler:** Sayısal RPO/RTO hedefi, veri sınıfları ve silme/retention yükümlülükleri, kimlik/uygulama yedeklerinin kurtarma sırası, bağımsız restore sahibi ve prosedür, gerçek hosted recovery tatbikatı. Bunlar bu dokümanla tamamlandı sayılmaz.

## PASS / HOLD kararı

**PASS (yalnızca D1 kapsam kararı belgesi):** D1'in yalnızca pilot kabul kapsamını sınırladığı, R-A/R-B farkı, D2–D4 açık durumu ve TR senaryolarının NOT RUN olduğu kaynaklarla doğrulanır; bağlantılar ve exact-head CI kontrol edilir, bağımsız review tamamlanır.

**HOLD:** D1 planlama kapsamını belirler, fakat **D2–D4 henüz OPEN**. Operasyon/security yetki ve gereksinimleri ayrı onay alana kadar test uygulaması, depolama migration'ı, restore aracı, tenant export, hosted pilot veya yeni altyapı çalışması başlatılmaz.

**P0-02 / L3 sonucu:** **NO-GO değişmedi.** Bu dosyanın birleşmesi P0-02 tamamlandı, DR sertifikalandı veya public L3 yetkilendirildi anlamına gelmez.
