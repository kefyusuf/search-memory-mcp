# P0-02 — Recovery kapsamı ve güncel yetki otoritesi karar kapısı

**Tarih:** 2026-10-13 · **Kaynak `main`:** [`8f89bdf`](https://github.com/kefyusuf/search-memory-mcp/commit/8f89bdf071a426d7202da6940fa6584e547377af) · **Durum:** **DECISION INPUT ONLY / tüm hosted recovery kararları OPEN / L3 NO-GO**

## Amaç ve sınır

Birleşen [P0-02 kanıt envanteri](2026-10-13-p0-02-hosted-recovery-evidence-gate.md) ile [restore/revocation test tasarımı](2026-10-13-p0-02-restore-authorization-test-design.md) arasında **ürün gereksinimi** ile **gelecekte test edilebilecek özelliği** ayırır. Özellikle, çok kiracılı **tam ortam felaket kurtarması** ihtiyacı ile **tek tenant/workspace seçilerek geri yükleme** özelliği aynı şey değildir.

[Production roadmap](../production-roadmap.md) P0-02 için storage-aware backup ve **boş ortama restore** kanıtı, P0-00b için tenant migration/restore yalıtımı ister; ilk public pilot için kullanıcıya sunulan tenant-seçmeli restore endpoint'i veya UI şart koşmaz. Burada bu ayrımın **hangi ürün kararıyla kesinleşeceği** yazılır; karar verilmiş gibi gösterilmez.

**Yalnızca bu iş biriminde:** dört karar sorusu, seçenek/sınır, asgari güvenlik koşulları ve gelecekteki kanıt bağımlılığı. **Yok:** uygulama/test/SQL, veritabanı veya cloud seçimi, operatör kimliği açma, backup komutu, endpoint, Docker/CI/config, maliyet taahhüdü, migration, release ve public deployment.

## Doğrulanmış mevcut sınır

- [Yerel SQLite backup/restore](../sqlite-backup-restore.md), dört store'un aynı dosyadaki *bütün* scope'larını taşır ve yalnızca yazımları durdurulmuş lokal fixture'ı bağımsız hedefe açmayı kanıtlar. Tenant export ve hosted recovery değildir.
- [PostgreSQL membership read model](../hosted-membership.md), aktif/grant/revoked üyeliği sorgular, ancak identity verisi ayrı depoda ve bu prototipin point-in-time restore'u test edilmedi. [Transaction-bound audit](../hosted-membership-audit.md) aynı identity işleminin değişim kaydını tutar; farklı yedek tarihlerinde güncel yetkiyi garanti eden *bağımsız otorite* değildir.
- [Request context](../../src/runtime/request-context.ts) ve [hosted HTTP auth factory](../../src/runtime/hosted-http-auth.ts) geçerli yetkilendirme bağlamına ilişkin mevcut sınırları gösterir. Üretim hosted bootstrap, operatör restore kontrolü ve kimlik ile veri arasında atomik restore/fencing bulunmaz.
- [Membership SQL izinleri](../../migrations/0001-hosted-membership.sql) arama/içerik/knowledge/memory/status/cache için tanımlıdır; **restore yönetimi için public MCP izni** veya kullanıcıya açık restore akışı içermez.

## Kararların açık listesi — bu PR seçimleri onaylamaz

| ID | Kesinleştirilecek karar | Kapsamı küçük tutan **öneri** (onay değil) | Karar verilmezse |
| --- | --- | --- | --- |
| D1 — Restore granülerliği | İlk pilotta boş ortama tam çevre recovery yeterli mi, tenant/workspace seçmeli restore ayrı ürün gereksinimi mi? | İlk hosted pilot için ayrı boş hedefte **tam ortam kurtarmasını** değerlendirin; tenant/workspace-seçmeli restore, müşteri gereksinimi doğrulanıncaya kadar **HOLD** olsun. Aynı fiziksel backup'ı tenant export olarak sunmayın. | D1 **OPEN**. Tam ortam hosted recovery kanıtı yine gereklidir; tenant-seçmeli iş otomatik başlatılamaz. |
| D2 — Restore yetkisi | Restore isteğini, onayını, yürütmesini, doğrulamasını ve yayına almayı kim yetkilendirir? | İstek, onay, başlatma, doğrulama ve aktif hale getirme sorumlularını **güvenilen operasyon yolu** kapsamında açıkça belirleyin; mevcut kullanıcının `memory:write` / `cache:manage` gibi tool izinlerini restore yetkisine yükseltmeyin. İnsan onayı/rol akışı henüz tasarlanmadı. | D2 **OPEN**. Canlı veri restore işlemi veya dışa açık araç devreye alınamaz. |
| D3 — Restore sonrası geçerli yetki | Eski identity yedeğinden dönüşten sonra revocation ve grant azaltmanın güncel otoritesi nasıl korunur? | Eski identity backup'ının yeni revocation/grant azaltma kararlarını geri almadığı **bağımsız biçimde kanıtlanmalı**. Güncel yetkinin nereden ve hangi rollback sınırının dışından doğrulanacağı ya da nasıl uzlaştırılacağı henüz seçilmedi. Sadece eski audit snapshot'ı veya yeni restore edilmiş membership satırını yeterli saymayın. | D3 **OPEN**. Restore edilmiş ortamda hosted erişim **fail closed** kalmalıdır. |
| D4 — Yayına alma / hata sınırı | Restore hedefi hangi doğrulama, fencing ve geri dönüş koşullarında etkin hale getirilebilir? | Önce izolasyonlu hedef ve bütünlük/tenant sahiplik/yetki doğrulaması; aktif hedefe geçiş, erişim durdurma, yeniden deneme ve hata halinde kaynak koruma kuralları **ayrı** tanımlanmalı. Mevcut iki DB'nin atomik snapshot/restore'u kanıtlanmadı. | D4 **OPEN**. Üretim veri yoluna restore hedefi bağlanamaz. |

## Ayrı ele alınması gereken iki senaryo

**R-A — Tam ortam felaket kurtarması (ilk hedef adayı):** Tüm scope'ların aynı fiziksel imajda yer alması beklenebilir, ancak backup ve hedef yalnızca yetkili operatöre açık olmalıdır. Canlı trafiğe dönmeden önce veri bütünlüğü, cross-tenant isolation, identity/audit ile güvenli yetki uzlaştırması ve bozulmuş/eksik backup'ta fail-closed kanıtı gerekir. Bu bir **tasarım önerisi**, henüz uygulanan veya yeterli şekilde test edilen bir işlem değildir.

**R-B — Tek workspace/tenant restore (ayrı özellik adayı):** Başka workspace/tenant kayıtları zarar görmeden yalnızca istenen alanın tutarlı taşınması, ID eşlemesi, belge/chunk/graph bütünlüğü ve yetki modelinin ayrı tasarımı gerekir. [TR-02](2026-10-13-p0-02-restore-authorization-test-design.md) bunu test etmek için yazılmıştır; ürün gereksinimi **onaylanmadıkça** R-B'yi ilk pilotun zorunlu uygulaması saymayın.

## Kanıt eşlemesi ve durdurma koşulları

| Kaynak kabul maddesi | Bu kapının yapacağı | Henüz yapılmayan |
| --- | --- | --- |
| [TR-01](2026-10-13-p0-02-restore-authorization-test-design.md) fiziksel backup/scope | R-A ile R-B farkını açık tutar | Çok-scope restore fixture'ı **NOT RUN** |
| TR-02 selective A1 restore | D1 onayına bağlı **HOLD** adayı | Tenant-selective API/restore testi **NOT RUN** |
| TR-03 revocation geri gelmemesi | D3 için bağımsız güncel yetki kanıtını **zorunlu ön koşul** yapar | Restored PostgreSQL + application DB birlikte test edilmedi |
| TR-04 bozuk/yarım restore, otorite erişilemiyor | D2/D4 fail-closed ve publish-onayı sınırını ister | Hosted failure injection **NOT RUN** |
| TR-05 forged/local context | Hosted'ın trusted local context'e geri düşmesini yasaklayan sınırı korur | Hosted restore-specific test **NOT RUN** |

**Sabit güvenlik koşulu:** Recovery başarısı, auth check'in yalnızca restore edilmiş eski snapshot'a karşı geçmesi demek değildir. Geçerli iptal/ownership kararları doğrulanamıyorsa veya cross-tenant erişim sınırı kanıtlanamıyorsa veri sunulmaz. Bütünlük kontrolü, güncel yetki ispatı yerine geçmez. Identity/tenant geçmişinin nasıl korunduğuna dair çözüm **bu belgede seçilmez**.

**Ayrı açık işler:** Sayısal RPO/RTO hedefi, veri sınıfları ve silme/retention yükümlülükleri, kimlik/uygulama yedeklerinin kurtarma sırası, bağımsız restore sahibi ve prosedür, gerçek hosted recovery tatbikatı. Bunlar bu dokümanla tamamlandı sayılmaz.

## PASS / HOLD kararı

**PASS (yalnızca karar girdisi):** Yukarıdaki D1–D4 soruları mevcut kaynaklara karşı doğru anlatılır, R-A/R-B kapsam ayrımı korunur, hiçbir uygulanmamış test kanıtlanmış gösterilmez, bağlantılar ve exact-head CI doğrulanır, bağımsız review tamamlanır.

**HOLD:** D1–D4 için ürün/operasyon/security yetki ve gereksinimleri ayrı onay alana kadar test uygulaması, depolama migration'ı, restore aracı, tenant export, hosted pilot veya yeni altyapı çalışması başlatılmaz.

**P0-02 / L3 sonucu:** **NO-GO değişmedi.** Bu dosyanın birleşmesi P0-02 tamamlandı, DR sertifikalandı veya public L3 yetkilendirildi anlamına gelmez.
