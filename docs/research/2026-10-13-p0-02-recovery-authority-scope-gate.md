# P0-02 — Recovery kapsamı ve güncel yetki otoritesi karar kapısı

**Tarih:** 2026-10-13 · **Kaynak `main`:** [`8f89bdf`](https://github.com/kefyusuf/search-memory-mcp/commit/8f89bdf071a426d7202da6940fa6584e547377af) · **Durum (2026-10-13 D1/D2 kapsam güncellemesi):** **D1 pilot kapsamı belirlendi / D2 yalnızca güven sınırı belirlendi, operasyonel onay mekanizması OPEN / D3–D4 OPEN / P0-02 ve L3 NO-GO**
**Durum güncellemesi (2026-10-26):** **D2 OPERATOR WORKFLOW APPROVED** — D2-K1–K4 harici yetki kararı [issue #83 karar kaydı](https://github.com/kefyusuf/search-memory-mcp/issues/83#issuecomment-6425870367) ile onaylandı; D2-E1–E5 **NOT RUN** kalır. **D3–D4 OPEN / TR-02–TR-05 NOT RUN / R-B HOLD / P0-02 ve L3 NO-GO** değişmedi.

## Amaç ve sınır

Birleşen [P0-02 kanıt envanteri](2026-10-13-p0-02-hosted-recovery-evidence-gate.md) ile [restore/revocation test tasarımı](2026-10-13-p0-02-restore-authorization-test-design.md) arasında **ürün gereksinimi** ile **gelecekte test edilebilecek özelliği** ayırır. Özellikle, çok kiracılı **tam ortam felaket kurtarması** ihtiyacı ile **tek tenant/workspace seçilerek geri yükleme** özelliği aynı şey değildir.

[Production roadmap](../production-roadmap.md) P0-02 için storage-aware backup ve **boş ortama restore** kanıtı, P0-00b için tenant migration/restore yalıtımı ister; ilk public pilot için kullanıcıya sunulan tenant-seçmeli restore endpoint'i veya UI şart koşmaz. Bu ayrım için **D1 ilk pilot kapsamı** aşağıda kararlaştırılmıştır; bunun dışında restore yetkisi, teknik uygulama ve yayın onayı verilmez.

**Yalnızca bu iş biriminde:** dört karar sorusu, seçenek/sınır, asgari güvenlik koşulları ve gelecekteki kanıt bağımlılığı. **Yok:** uygulama/test/SQL, veritabanı veya cloud seçimi, operatör kimliği açma, backup komutu, endpoint, Docker/CI/config, maliyet taahhüdü, migration, release ve public deployment.

## Doğrulanmış mevcut sınır

- [Yerel SQLite backup/restore](../sqlite-backup-restore.md), dört store'un aynı dosyadaki *bütün* scope'larını taşır ve yalnızca yazımları durdurulmuş lokal fixture'ı bağımsız hedefe açmayı kanıtlar. Tenant export ve hosted recovery değildir.
- [PostgreSQL membership read model](../hosted-membership.md), aktif/grant/revoked üyeliği sorgular, ancak identity verisi ayrı depoda ve bu prototipin point-in-time restore'u test edilmedi. [Transaction-bound audit](../hosted-membership-audit.md) aynı identity işleminin değişim kaydını tutar; farklı yedek tarihlerinde güncel yetkiyi garanti eden *bağımsız otorite* değildir.
- [Request context](../../src/runtime/request-context.ts) ve [hosted HTTP auth factory](../../src/runtime/hosted-http-auth.ts) geçerli yetkilendirme bağlamına ilişkin mevcut sınırları gösterir. Üretim hosted bootstrap, operatör restore kontrolü ve kimlik ile veri arasında atomik restore/fencing bulunmaz.
- [Membership SQL izinleri](../../migrations/0001-hosted-membership.sql) arama/içerik/knowledge/memory/status/cache için tanımlıdır; **restore yönetimi için public MCP izni** veya kullanıcıya açık restore akışı içermez.

## Karar durumu — D1 kapsamı ve D2 güven sınırı (yalnızca planlama)

| ID | Karar sorusu | Kapsamı küçük tutan yaklaşım | Durum ve yürütme sınırı |
| --- | --- | --- | --- |
| D1 — Restore granülerliği | İlk pilotta boş ortama tam çevre recovery yeterli mi, tenant/workspace seçmeli restore ayrı ürün gereksinimi mi? | İlk hosted pilotun **hedef kabul kapsamı R-A: ayrı/boş hedefe tam ortam kurtarması**. **R-B: tenant/workspace-seçmeli restore HOLD**, doğrulanmış müşteri gereksinimi doğmadan başlatılmaz. Fiziksel backup hiçbir zaman tenant export olarak sunulmaz. | **D1 SCOPE DECIDED (planlama):** Gerekli hosted kanıt henüz YOK. D2–D4 ve ayrı implementation/test onayı olmadan bu karar yürütme yetkisi değildir. |
| D2 — Restore yetkisi | Restore isteğini, onayını, yürütmesini, doğrulamasını ve yayına almayı kim yetkilendirir? | İlk pilot için restore **yalnızca güvenilen, uygulama/MCP istek yolundan ayrı operasyonel yetki sınırı** içindedir. Normal tool izinleri, tenant üyeliği ve identity DB rollerinin varlığı restore yetkisi vermez. | **D2 OPERATOR WORKFLOW APPROVED (2026-10-26):** roller, onay kanalı, bağlayıcılık, erişim/iptal ve bağımsız kayıt [issue #83 karar kaydında](https://github.com/kefyusuf/search-memory-mcp/issues/83#issuecomment-6425870367) onaylandı. D2-E1–E5 operasyonel kanıtı **NOT RUN**; canlı restore ve public endpoint **NO-GO**. |
| D3 — Restore sonrası geçerli yetki | Eski identity yedeğinden dönüşten sonra revocation ve grant azaltmanın güncel otoritesi nasıl korunur? | Eski identity backup'ının yeni revocation/grant azaltma kararlarını geri almadığı **bağımsız biçimde kanıtlanmalı**. Güncel yetkinin nereden ve hangi rollback sınırının dışından doğrulanacağı ya da nasıl uzlaştırılacağı henüz seçilmedi. Sadece eski audit snapshot'ı veya yeni restore edilmiş membership satırını yeterli saymayın. | D3 **OPEN**. Restore edilmiş ortamda hosted erişim **fail closed** kalmalıdır. |
| D4 — Yayına alma / hata sınırı | Restore hedefi hangi doğrulama, fencing ve geri dönüş koşullarında etkin hale getirilebilir? | Önce izolasyonlu hedef ve bütünlük/tenant sahiplik/yetki doğrulaması; aktif hedefe geçiş, erişim durdurma, yeniden deneme ve hata halinde kaynak koruma kuralları **ayrı** tanımlanmalı. Mevcut iki DB'nin atomik snapshot/restore'u kanıtlanmadı. | D4 **OPEN**. Üretim veri yoluna restore hedefi bağlanamaz. |

## D1 karar kaydı — yalnızca ilk pilotun kabul kapsamı

**Seçim:** İlk hosted pilotun P0-02 kurtarma kabul hedefi **R-A: uygulama verisi ve ayrı identity/audit deposu için güvenli, boş ve yalıtılmış ortamda tam kurtarma senaryosudur**. Bu, teknik depolama mimarisi, iki bağımsız deponun atomik restore yöntemi veya tamamlanmış DR tatbikatı seçimi değildir.

**Kapsam dışı / HOLD (yalnızca seçmeli restore özelliği):** Tek tenant/workspace için geçmiş backup/snapshot'tan seçmeli import/restore, bu işleme özgü rollback UI'si veya yeni restore MCP tool'u ilk pilotun gerekli özelliği sayılmaz. Bu HOLD, [roadmap'deki](../production-roadmap.md) **kullanıcı verisi silme/export, belge ve graph temizliği, retention/deletion** yükümlülüklerini ertelemez; bunlar D1'den ayrı kabul kapılarıdır. Gelecekte doğrulanmış müşteri ihtiyacı, maliyet/fayda ve ayrı izinli iş birimi bulunursa seçmeli restore kapsamı yeniden değerlendirilebilir.

**Neden:** [Roadmap'in P0-02 kabulü](../production-roadmap.md) storage-aware backup ve **boş ortama restore** ispatı ister. Yerel [SQLite fiziksel prova](../sqlite-backup-restore.md) ise tüm scope'ları aynı dosyayla taşır ve hosted yetki/kimlik geri yüklemesi değildir. Tenant-seçmeli özelliği erken seçmek, bu eksikleri çözmeden yeni migration/authorization yüzeyi ekler.

**D1'in çözmediği zorunlu kapılar:** D2 için güven sınırı belirlenmiş olsa da gerçek operatör ve onay sorumlusu hâlâ açık; D3 restore sonrası güncel revocation/grant otoritesi (eski yedeğe bakmak yeterli değildir); D4 yalıtılmış hedefte bütünlük, cross-tenant doğrulama ve fail-closed aktivasyon. Sayısal RPO/RTO, retention ve backup güvenliği ayrıca belirlenmelidir. Bunların hiçbiri bu kapsam kararıyla PASS olmaz.

**Uygulama izni:** **YOK**. Mevcut hosted built-in handler'lar açılmaz, DB/tenant restore kodu veya test altyapısı eklenmez. TR-01–TR-05 bu karar yüzünden çalıştırılmış sayılmaz. **P0-02 ve public L3 NO-GO** sürer.

## D2 karar kaydı — güvenilen operasyon sınırı, yetkilendirme uygulaması değil

**İlk pilot güven sınırı kararı:** Tam ortam recovery yedeklerinin **bütün tenant/workspace verilerini** içermesi beklenebilir. Yedek okuma, boş hedefe restore denemesi ve hedefi etkin hale getirme, kamuya açık MCP istekleriyle veya workspace üyeliğiyle devredilemez. **Yalnızca dağıtım tarafından güvenilen, uygulama runtime'ından ayrı operasyonel süreç/kişi yetkilendirmesi adayı** olarak tutulur. Henüz gerçek operatör, rol, credential ya da onay yöntemi seçilmedi; bu karar mevcut bir operasyon yüzeyi yaratmaz.

**Mevcut yetkilere yapılamayacak eşleme:**

- [`request-context.ts`](../../src/runtime/request-context.ts) içinde restore veya operasyonel backup yetkisi yoktur. `memory:write`, `cache:manage`, `knowledge:write`, admin benzeri workspace membership veya token scope tek başına restore hakkı vermez. Local trusted stdio context'i de hosted restore yetkisinin yerine geçirilemez.
- [`0001-hosted-membership.sql`](../../migrations/0001-hosted-membership.sql) workspace/grant read-model şemasıdır. [Membership operator / reader / audit-reader](../hosted-membership-audit.md) DB rolleri yalnızca kimlik yönetimi ve denetimi için tariflenir; bunları backup/restore operatörü olarak yorumlamayın. Ayrı migration owner credential'ı da otomatik olarak recovery approver değildir.
- [`0002-hosted-membership-audit.sql`](../../migrations/0002-hosted-membership-audit.sql) kimlik tablolarının DML değişikliklerini transaction içinde kaydeder. Restore talebi, insanın onayı, backup erişimi, restore denemesi, veri yayımlama ve reddedilen girişimleri **bu audit otomatik kaydetmez**. `SESSION_USER` paylaşılan service login ise gerçek insanı kanıtlamaz.

**D2'nin henüz verilmemiş operasyon kararları:** Kim isteyebilir ve olay/ticket bağlamını kim doğrular? Kim onaylar, hangi kimlik/credential ile yürütür ve ayrı hedefi kim kontrol eder? Kim yayına alma talimatını verip D3/D4 kanıtlarını kabul eder? İzin/backup kapsamı, görev ayrımı gereksinimi, kanıt kaydı, erişim iptali ve acil erişim prosedürü onaylanmadan **işletim yetkisi verilmiş sayılmaz**. İki-kişi onayı, yeni IAM platformu veya kalıcı admin panel bu belgeyle zorunlu teknoloji/uygulama kararı haline getirilmez.

**Doğrulanması gereken olumsuz senaryolar (henüz NOT RUN):** Normal hosted token/workspace izniyle restore denemesi **deny**; local fallback ve değiştirilebilir request context **deny**; yetkisiz backup okumaları **deny**; kimliği/onayı doğrulanamayan operatör veya kaydı olmayan işlem **fail closed**; yalnızca backup/restore başarı logu, güncel revocation'a (D3) veya güvenli aktivasyona (D4) kanıt sayılmaz. Bu satırlar uygulanmış test değil, gelecekteki yetki/operasyon kabul girdileridir.

**Sabit sınır:** D2 güven sınırının belgelenmesi, restore komutu, kontrol paneli, approval servisi, SQL/secret/role yaratımı, yeni MCP permission, aktif veri taşıma veya deployment izni değildir. P0-06 kullanıcı verisi silme/export yükümlülükleri bundan bağımsızdır. D2 operasyon akışı, D3 ve D4 kapıları açık kaldığından **P0-02 ve public L3 NO-GO**.

## D2 operasyonel kanıt matrisi — kabul tasarımı, uygulanmış kontrol değil

Aşağıdaki kapılar yalnızca D1'deki **R-A (ayrı/boş hedefte tam ortam kurtarma)** için asgari *kanıt ihtiyacını* tanımlar; ürün/operasyon yetkilisi, rol ayrımı, ticket/IAM, imza formatı veya restore mekanizması seçmez. Her satır **NOT RUN / D2 OPERATOR WORKFLOW OPEN**; bugünkü [membership audit](../hosted-membership-audit.md) veya başarılı genel CI bu kanıtları üretmez. Kayıtların kim tarafından, hangi güvenilen ve geri yüklemeden etkilenmeyen kanalda tutulacağı ayrı operatör kararıdır.

| ID | Operasyon sınırı | İlerde doğrulanacak asgari kayıt / ilişki | Eksik veya tutarsızsa |
| --- | --- | --- | --- |
| D2-E1 | Talep | Kimliği doğrulanmış talep sahibi, gerekçe/olay referansı, etkilenen ortam ve **tam** backup kapsamı; ayrı hedef kimliğiyle eşleştirilmiş **restore öncesi boş hedef durumu doğrulama kanıtı** (ne zaman ve hangi hedef için doğrulandığı); gerçek müşteri verisi/sır içermeyen izlenebilir işlem referansı | Talep, hedef kimliği veya aynı hedefin restore öncesi boş olduğuna ilişkin kanıt yoksa recovery başlatılmaz |
| D2-E2 | Yetki/onay | Güvenilen operasyon otoritesinin **o talep, backup ve hedefe özgü** onayı, onaylayan kimlik ve karar kaydı; onay sahibi/ikinci kişi zorunluluğu henüz seçilmedi | Onaysız, iptal edilmiş veya farklı hedefe taşınmış talep reddedilir |
| D2-E3 | Yürütme | Kimliği doğrulanan yürütücü ve onay kaydına bağlanan işlem, seçilen backup/hedef, başlangıç, sonuç ve kısmi hata izi; yetki, mevcut MCP scope'larından/DB üyeliğinden türetilemez | Bağ koparsa işlem durdurulur; belirsiz sonuç başarı sayılmaz |
| D2-E4 | Bağımsız doğrulama için devir | Restore edilen **yalıtılmış hedefe** ait bütünlük ve tenant sınırı bulgularının hangi kontrolcüye sunulduğu; **D3 güncel revocation kanıtının** ayrıca gerekli olduğu açıkça kaydedilir | Yalnızca restore logu veya geçmiş audit snapshot'ı yeterli değildir; hedef veri sunamaz |
| D2-E5 | Aktivasyon talebi | D2 operasyon yetkisinin **D4'teki ayrı aktivasyon/fencing kararının yerine geçmediği**; varsa go/no-go kararı ile hedef/revizyon eşlemesi | D4 kanıtı ve yetkili aktivasyon kararı yoksa hedef üretim trafiğine bağlanmaz |

**Negatif kabul kapısı (NOT RUN):** Normal hosted token, local trusted context, membership DB operator/owner rolü veya yalnızca `SESSION_USER` kaydı ile E1–E5 atlanamaz. Onay iptali, backup/hedef değişimi, sahte yetkili, eksik audit bağlantısı, kısmi yürütme ve otoriteye erişememe **deny/fail closed** gerektirir; aktif kaynak korunur. Bu ifadeler tasarlanmış test beklentileridir, bugünkü otomatik enforcement/operasyon prosedürü değildir.

**Açık karar:** Güvenilen gerçek kişi/organizasyon, görev ayrımı, onay kanalı, kanıtın saklanması/retention, erişim iptali ve acil erişim (break-glass) prosedürü ayrıca kararlaştırılmalıdır. D2'nin bu matrisi D3'ün taze yetki otoritesini veya D4'ün atomik/yalıtılmış yayına alma sınırını çözmez; **TR-01 LOCAL PASS (yalnızca yerel fiziksel SQLite); TR-02–TR-05 NOT RUN; P0-02/public L3 NO-GO** devam eder.

## D2 operasyon otoritesi — karar fişi (henüz onay değil)

[D2-E1–E5](#d2-operasyonel-kanıt-matrisi--kabul-tasarımı-uygulanmış-kontrol-değil) **hangi kanıtın** beklendiğini tanımlar; bu fiş ise R-A tam ortam kurtarma tatbikatından önce **kimin hangi yetkiyle** karar vereceğini netleştirmesi gereken açık seçimlerdir. **Önerilen en küçük değerlendirme adayı:** uygulama/MCP runtime'ının dışında, dağıtım tarafından güvenilen insan operatör ve talep-hedef-backup özelinde kayda alınmış manuel onay/doğrulama. Bu **seçilmiş veya işler durumda bir operasyon modeli değildir**; yeni onay servisi, admin paneli ya da IAM ürünü gerektirmez. Gereksinimler bunu karşılamazsa ayrı teknoloji ve güvenlik kararı gerekir.

| ID | Onaylanmadan önce açıkça cevaplanacak karar | Kabul için gerekli ilişki (hepsi OPEN / NOT RUN) |
| --- | --- | --- |
| D2-K1 — Yetki sahipliği | Talep, onay, yürütme, bağımsız kontrol ve D4 aktivasyon kararının **sorumlu organizasyonu/rolü** kim; görevlerin aynı kişide birleşmesine izin var mı? | Güvenilen deployment otoritesi tarafından kayıtlı sorumluluk ve görev ayrımı gerekçesi; mevcut MCP scope'u, workspace üyeliği ve DB rolü sahiplik kanıtı olamaz |
| D2-K2 — Onayın bağlayıcılığı | Onay hangi kanaldan, hangi süre/geçersizleşme kuralıyla, **talep + tam backup + boş hedef + revision** için verilir ve iptal edilir? | E1–E3 kanıtına bağlanan, hedef veya kapsam değiştiğinde geçersizleşen izlenebilir onay; işlem yalnızca onaydan sonra ve izole hedefte |
| D2-K3 — Erişim ve iptal | Backup'a kim erişir; yürütme credential'ı, asgari yetki, erişim iptali ve insanın kimlik doğrulaması nasıl sağlanır? | Uygulama/identity restore sınırının dışında doğrulanabilir kaynak; tek başına `SESSION_USER`, local trusted context veya service token yeterli sayılmaz |
| D2-K4 — Dış kanıt ve istisna | Talep, ret, backup erişimi, onay, yürütme/hata, doğrulama ve acil durum kararları kimce nerede, hangi erişim/retention ile saklanır? | Eski backup ile geri sarılmayan güvenilen kayıt ve belirli bir istisna sahibi; belirsiz veya erişilemez onay/kanıtta **deny**, kayıtsız break-glass yok |

**Seçim kapısı:** Ürün/operasyon güvenlik sorumlusu D2-K1–K4 kararını ve kullanılacak güvenilen kanıt kanalını **ayrı olarak açıkça onaylamadıkça** D2 OPERATOR WORKFLOW **OPEN** kalır. Bu repo gerçek kişi adları, sırlar, credential değerleri, müşteri backup'ı veya üretim erişim kayıtları için karar arşivi değildir. D2'de onaylanacak restore yürütmesi, [D3 güncel yetki](#d3-güncel-yetki-otoritesi--karar-öncesi-kanıt-kapısı-seçim-değil) veya [D4 aktivasyon](#d4-güvenli-aktivasyonfencing--kabul-kanıtı-kapısı-uygulama-değil) onayı yerine geçmez.

**Durum (2026-10-26 güncellemesi):** D2-K1–K4 **APPROVED** — roller (talep: ajan oturumları; onay/aktivasyon: repository owner hesabı, 2FA; yürütme: onay sonrası ajan; bağımsız doğrulama: CI + verifier scriptleri), onay kanalı (bu repodaki owner-hesap yorumları, talep+backup+boş hedef+revizyona bağlı, 7 gün geçerli), erişim/iptal kaynağı (GitHub 2FA kimliği; uygulama token'ı/üyelik/DB rolü/restore edilmiş audit asla değil) ve bağımsız kayıt kanalı (issue #83 + bağlantılı PR'lar, break-glass 24 saat içinde kayıt) [karar kaydında](https://github.com/kefyusuf/search-memory-mcp/issues/83#issuecomment-6425870367) onaylandı. Dual control = insan onayı + insan-dışı bağımsız doğrulama; operatör erişilemezse restore yapılmaz (fail closed, vekil yok). **D2-E1–E5 NOT RUN kalır** (operasyonel kanıt, karar değil). D3/D4 **OPEN**, TR-01 **LOCAL PASS** (yalnızca yerel fiziksel SQLite), TR-02–TR-05 **NOT RUN**, **P0-02/public L3 NO-GO**. **R-B seçmeli tenant restore HOLD**; bağımsız P0-06 silme/export/retention yükümlülükleri değişmez.


## D2 karar devri — dış yetki kanıtı kabul koşulu (NOT RUN)

[D2-K1–K4](#d2-operasyon-otoritesi--karar-fişi-henüz-onay-değil) açık sorularının yazılı olarak cevaplanması **tek başına** operasyonel yetki değildir. Ürün/operasyon güvenlik otoritesinin hangi kararı hangi güvenilir kayıtta onayladığının, geri alınabilirliğinin ve [D2-E1–E5](#d2-operasyonel-kanıt-matrisi--kabul-tasarımı-uygulanmış-kontrol-değil) ile ilişkisinin ayrıca doğrulanması gerekir. Bu bir **dış kararın değerlendirme girdisi** tanımıdır; burada bir operatör veya onay kanalı tayin edilmez.

| Karar alanı | Yetkili incelemeden dönmesi gereken doğrulanabilir çıktı | Yoksa |
| --- | --- | --- |
| D2-K1 — Sahiplik | Yetkili organizasyonun karar sahibi, talep/onay/yürütme/bağımsız doğrulama/aktivasyon sorumluluklarının **rol bazlı** dağılımı ve görev ayrımı kararı; yetki dayanağının dış kayıt referansı | Görev/karar sahibi varsayılmaz; **OPEN** |
| D2-K2 — Sınırlı onay | İlgili E1–E3 işlem referansına, **tam backup kimliğine ve kapsamına, restore öncesi boşluğu kanıtlanmış hedef kimliğine ve hedef revizyonuna** bağlanan kararın güvenilir kayıt referansı; geçerlilik, süre sonu, değişiklik ve iptal kuralı | Önceki/genel onay başka hedefe veya revizyona taşınamaz; **deny** |
| D2-K3 — Erişim iptali | Operatör kimliği/yetki kaynağının rollback sınırı dışında nasıl doğrulandığı, en az yetki ve geçerli iptal kontrolünün sahibi ile bu kontrolün izlenebilir kanıt referansı | MCP token, membership/DB rolü veya restore edilmiş eski audit'e dayanarak **deny** |
| D2-K4 — Bağımsız kayıt | Talep, ret, onay/iptal, backup erişimi, yürütme ve hata, doğrulama ve istisnaların **restore ile geri sarılmayan** kayıt sahibi, erişim/retention sınırı ve kayıt referansı; break-glass yetkilisi ve kayıt kuralı | Kayıtsız/erişilemez kanıt veya kayıtsız istisnada **deny** |

**Değerlendirme sonucu (2026-10-26):** Dış karar verildi — yetkili D2-K1–K4 maddelerinin her birini **approved** olarak, karar zamanı (2026-10-26) ve geri alınamaz kayıt referansıyla ([issue #83 karar kaydı](https://github.com/kefyusuf/search-memory-mcp/issues/83#issuecomment-6425870367)) belirtti. Repoya yalnızca hassas olmayan karar durumu ve dış kanıt referansı yansıtıldı; gerçek kişi kimliği, müşteri backup'ı, sır veya production credential'ı aktarılmadı.

**Kalan bağımsız kapılar:** D2 kararı verilmiş olsa da **D3** güncel revocation otoritesi ve **D4** izolasyon/fencing/aktivasyon kanıtı ayrıca sağlanmadan restore hedefi etkinleştirilemez. **D2-K1–K4 APPROVED; D2-E1–E5 NOT RUN; D3/D4 OPEN; TR-01 LOCAL PASS; TR-02–TR-05 NOT RUN; R-B HOLD; P0-02/public L3 NO-GO**.

## D3 güncel yetki otoritesi — karar öncesi kanıt kapısı (seçim değil)

Bu kapı yalnızca D1 kapsamındaki **R-A tam ortam kurtarması** için gelecekteki yetki doğrulamasını ölçülebilir kılar. [PostgreSQL membership read-model](../hosted-membership.md) geçerli bağlamla okuma/checkpoint yapabilir; ancak **geri yüklenmiş eski membership tablosunu** yeniden okumak sonradan verilmiş revocation veya grant azaltmalarını kendiliğinden korumaz. [Transaction-bound audit](../hosted-membership-audit.md) de eski identity yedeğiyle beraber geri alınabilir; tek başına güncel veya rollback-dışı yetki kaynağı değildir. Güvenilen güncel otoritenin **hangi kaynaktan, kimin işlettiği ve rollback sınırının dışında nasıl doğrulanacağı hâlâ OPEN**.

| ID | Gelecekteki kanıt zorunluluğu (hepsi NOT RUN) | Kabul / ret sınırı |
| --- | --- | --- |
| D3-V1 — Kaynak | Restore edilen identity/audit snapshot'ından bağımsız biçimde **güncel yetki** sonucuna ulaşılabildiğini ve ilgili issuer, principal, tenant, workspace ile hedef kurtarma revizyonuna nasıl bağlandığını gösteren kaynak/provenance kanıtı | Yalnızca eski `workspace_memberships` satırı, eski audit kaydı, token claim'i veya backup zamanı **yeterli değil**; bağımsız otorite seçilmeden PASS yok |
| D3-V2 — Geriye gitmeyen iptal | [TR-03](2026-10-13-p0-02-restore-authorization-test-design.md) sentetik `S0` eski-yedek/`S1` yeni-revocation durumunda; ayrıca `S1` grant azaltma, workspace disable ve tenant ownership değişiminde restore sonrası hem mevcut/stale hem yeni hosted isteklerin **yetkisiz erişim alamadığını** kanıtla | Eski snapshot'ın aktif üyeliği geri getirmesi, yetki genişletmesi veya cross-tenant erişim **FAIL** |
| D3-V3 — Eksik/ulaşılamaz otorite | Güncel otoriteye ulaşılamayan, geçmiş ile güncel durum uzlaştırılamayan, issuer/scope tutarsız veya revocation kanıtı eksik senaryoda deny/fail-closed sonucu | Geçmiş backup'a ya da local trusted stdio context'ine fallback **yasak**; restore hedefi hosted erişime açılmaz |
| D3-V4 — Ayrı aktivasyon kapısı | D3 yetki kanıtının restore edilmiş hedef ve denetlenen revision ile eşleştirilip D2 doğrulama devrine aktarılması; D4 fencing/aktivasyon koşullarının **ayrıca** karşılanması | Doğru membership checkpoint sonucu tek başına restore'u yayına almaya **yetmez** |

**Gelecekteki seçim/kanıt ön koşulu:** Restore edilmeyen güvenilen otorite mi, güvenilir yeni değişikliklerle doğrulanabilir uzlaştırma mı, başka bir çözüm mü kullanılacak? Kaynak, yeniden oynatma/eksik kayıt davranışı, güncellik ölçütü, rollback/fencing sınırı ve bu kararın yetkili sahibi **henüz belirlenmedi**. Bu bölüm seçeneklerden hiçbirini seçmez; yeni servis, log deposu, event sourcing, migration, token politikası veya test implementasyonu istemez.

**Durum:** **D3 OPEN; D2 OPERATOR WORKFLOW OPEN; D4 OPEN**. D3-V1–V4 **NOT RUN** ve [TR-03/TR-04](2026-10-13-p0-02-restore-authorization-test-design.md) **NOT RUN**. Mevcut `npm test`, PostgreSQL membership/audit regresyonu ve Docker image smoke, restore sonrası güncel yetki kanıtı yerine geçmez. **P0-02 ve public L3 NO-GO**; R-B tenant-seçmeli restore HOLD ve bağımsız P0-06 silme/export/retention sorumlulukları değişmez.

## D4 güvenli aktivasyon/fencing — kabul kanıtı kapısı (uygulama değil)

Bu kapı sadece D1'deki **R-A ayrı/boş hedefe tam ortam kurtarması** içindir. Hedefin restore işlemini bitirmesi, sağlık kontrolünün başarılı olması, D2 operasyon onayı veya D3 üyelik kontrolü **tek başına üretim trafiğine çıkış yetkisi vermez**. Aşağıdaki sonuçlar gelecekteki yalıtılmış ve sentetik [TR-04](2026-10-13-p0-02-restore-authorization-test-design.md) kabulüne girdi sağlar; her biri **NOT RUN**. Günümüzde uygulanmış bir aktivasyon/fencing mekanizması yoktur.

| ID | Gelecekte gösterilmesi gereken kanıt (hepsi NOT RUN) | Fail-closed kabul / ret sınırı |
| --- | --- | --- |
| D4-A1 — İzolasyon ve hedef kimliği | Restore öncesi boş olduğu doğrulanan **ayrı hedefin** kimliği, backup kapsamı ve doğrulanan veri/identity revizyonu aynı işlem referansına bağlanır; restore ve yalıtılmış doğrulama için yetkilendirilmiş işlemler dışında hedefin hosted uygulama trafiğine ve uygulama yazılarına kapalı kaldığı gösterilir | Hedef, kapsam veya izolasyon belirsizse aktivasyon **deny**; mevcut aktif kaynak etkilenmez |
| D4-A2 — Bütünlük ve tenant sınırı | Uygulama verisi ile ayrı identity/audit restore'larının **birlikte tutarlı** kabul edilebildiği; eksik/bozuk/yarım backup, farklı revizyon ve A1/A2/B1 tenant sahiplik/erişim kontrollerinin sonuçları gösterilir; [D3 güncel yetki kanıtı](#d3-güncel-yetki-otoritesi--karar-öncesi-kanıt-kapısı-seçim-değil) ayrıca zorunludur | İki store'un atomik restore edildiği **varsayılmaz**; kapsam, tutarlılık, tenant izolasyonu veya D3 kanıtı eksikse hedef açılmaz |
| D4-A3 — Ayrı yayın kararı | D2'nin **o talep/backup/hedef için geçerli** onayı, D3 kanıtı, bağımsız doğrulama çıktısı ve **aynı değişmemiş hedef/revizyon** için ayrıca verilmiş aktivasyon go/no-go kararı birbirine bağlanır | Değişen hedef/revizyon, iptal edilmiş onay veya belirsiz yetkili kararında otomatik aktivasyon **yok** |
| D4-A4 — Tek etkin veri yolu | Geçiş sırasında eski ve yeni hedefin aynı anda yetkili hosted read/write kaynağı olmadığını, stale isteklerin/eski tokenların yeni yetkiyi aşmadığını ve erişim/yazım fencing sonucunu gösteren kontrollü kesit kanıtı | Çakışan yazma/servis yetkisi, doğrulanmamış geçiş veya stale yetkiyle veri sunulması **FAIL**; cutover mekanizması/atomiklik bu belgede seçilmez |
| D4-A5 — Hata ve tekrar deneme | Restore öncesi, sırasında, doğrulamada, aktivasyon öncesi ve belirsiz/kısmi cutover **sonrası** failure-injection durumları ayırt edilir; kaynak durumu, hedefin kapalı kalışı ve yeniden onay/doğrulama gereği kaydedilir | Aktivasyon öncesi hata aktif kaynağı değiştiremez; cutover sonrası belirsizlikte otomatik eski snapshot'a dönüş veya kontrolsüz tekrar yayın **yok**; yeni karar ve D3/D4 doğrulaması olmadan trafik açılmaz |

**Henüz kararlaştırılmamış sınırlar:** Üretim trafik/yazma durdurma ve yönlendirme yöntemi, farklı store'lar arası tutarlı nokta, doğrulayıcı ve aktivasyon yetkilisi, cutover'ın güvenilir tekliği, rollback/recovery prosedürü ile RPO/RTO ölçütleri **OPEN**. Tablo herhangi bir router, queue, lock, yeni IAM/otorite, snapshot ürünü, ikinci aktif ortam veya otomatik failover tasarımı seçmez.

**Durum:** **D4 OPEN**; D2 operatör/onay akışı ve D3 güncel revocation otoritesi de **OPEN**. D4-A1–A5 **NOT RUN**; TR-01 **LOCAL PASS** (yerel fiziksel SQLite), TR-02–TR-05 **NOT RUN**. İzole hedefte restore edilmiş verinin kullanılabilirliği veya genel CI/Docker başarısı hosted recovery kanıtı değildir. **P0-02 / public L3 NO-GO**; **R-B tenant/workspace-selective restore HOLD** ve bağımsız **P0-06 silme/export/retention** yükümlülükleri değişmez.

## Ayrı ele alınması gereken iki senaryo

**R-A — Tam ortam felaket kurtarması (ilk hedef adayı):** Tüm scope'ların aynı fiziksel imajda yer alması beklenebilir, ancak backup ve hedef yalnızca yetkili operatöre açık olmalıdır. Canlı trafiğe dönmeden önce veri bütünlüğü, cross-tenant isolation, identity/audit ile güvenli yetki uzlaştırması ve bozulmuş/eksik backup'ta fail-closed kanıtı gerekir. Bu senaryo **D1 kapsamında ilk pilot için hedeflenen kurtarma granülerliğidir**; henüz uygulanmış veya hosted ortamda yeterli şekilde test edilmiş değildir. D2–D4 çözülmeden restore yayımlanmaz.

**R-B — Tek workspace/tenant restore (ayrı özellik adayı):** Başka workspace/tenant kayıtları zarar görmeden yalnızca istenen alanın tutarlı taşınması, ID eşlemesi, belge/chunk/graph bütünlüğü ve yetki modelinin ayrı tasarımı gerekir. [TR-02](2026-10-13-p0-02-restore-authorization-test-design.md) gelecekteki kabul tasarımıdır; **D1 kararıyla R-B ilk pilot kapsamı dışında HOLD** durumundadır. Yalnızca doğrulanmış müşteri/iş gereksinimi ve ayrı kapsam kararıyla yeniden açılabilir.

## Kanıt eşlemesi ve durdurma koşulları

**Kanıt senkronizasyonu (2026-10-15, yalnızca durum kaydı):** [PR #79](https://github.com/kefyusuf/search-memory-mcp/pull/79) `362dd0ccd5834030f5e3c8039654a0f9f6e47ff7` ile `main` üzerine birleştirildi; [post-merge CI #38770708083](https://github.com/kefyusuf/search-memory-mcp/actions/runs/38770708083) **SUCCESS** ile TR-01'in çok-scope **yerel fiziksel SQLite** regresyon testi doğrulandı. Ayrı [Docker #38770707916](https://github.com/kefyusuf/search-memory-mcp/actions/runs/38770707916) **SUCCESS** yalnızca image build/smoke-test kanıtıdır; TR-01 testini çalıştırdığı veya doğruladığı anlamına gelmez. D2-E1–E5, D2-K1–K4, D3-V1–V4, D4-A1–A5 ve TR-02–TR-05 **NOT RUN / OPEN** kalır. Hosted boş hedefe tam kurtarma, güncel revocation otoritesi veya güvenli aktivasyon kanıtlanmış değildir. **R-B HOLD; P0-02/public L3 NO-GO; P0-06 yükümlülükleri bağımsız**.

| Kaynak kabul maddesi | Bu kapının yapacağı | Kanıt / kalan boşluk |
| --- | --- | --- |
| [TR-01](2026-10-13-p0-02-restore-authorization-test-design.md) fiziksel backup/scope | R-A ile R-B farkını açık tutar | **LOCAL PASS** — A1/A2/B1 içeren dört SQLite store'un bütün-scope fiziksel yedeği [PR #79](https://github.com/kefyusuf/search-memory-mcp/pull/79), [test](../../src/__tests__/sqlite-backup-restore.test.ts), [main CI #38770708083](https://github.com/kefyusuf/search-memory-mcp/actions/runs/38770708083) ile doğrulandı; hosted R-A recovery ve ayrı identity/audit restore'u **NOT RUN** |
| TR-02 selective A1 restore | D1 kapsam kararıyla ilk pilot için **HOLD**; ancak doğrulanmış müşteri ihtiyacı ve ayrı onayla gündeme alınır | Tenant-selective API/restore testi **NOT RUN** |
| TR-03 revocation geri gelmemesi | D3 için bağımsız güncel yetki kanıtını **zorunlu ön koşul** yapar | Restored PostgreSQL + application DB birlikte test edilmedi |
| TR-04 bozuk/yarım restore, otorite erişilemiyor | D2/D4 fail-closed ve publish-onayı sınırını ister | Hosted failure injection **NOT RUN** |
| TR-05 forged/local context | Hosted'ın trusted local context'e geri düşmesini yasaklayan sınırı korur | Hosted restore-specific test **NOT RUN** |

**Sabit güvenlik koşulu:** Recovery başarısı, auth check'in yalnızca restore edilmiş eski snapshot'a karşı geçmesi demek değildir. Geçerli iptal/ownership kararları doğrulanamıyorsa veya cross-tenant erişim sınırı kanıtlanamıyorsa veri sunulmaz. Bütünlük kontrolü, güncel yetki ispatı yerine geçmez. Identity/tenant geçmişinin nasıl korunduğuna dair çözüm **bu belgede seçilmez**.

**Ayrı açık işler:** Sayısal RPO/RTO hedefi, veri sınıfları ve silme/retention yükümlülükleri, kimlik/uygulama yedeklerinin kurtarma sırası, bağımsız restore sahibi ve prosedür, gerçek hosted recovery tatbikatı. Bunlar bu dokümanla tamamlandı sayılmaz.

## PASS / HOLD kararı

**PASS (yalnızca D1/D2 kapsam belgesi):** D1 pilot kapsamı ve D2 güven sınırının yürütme yetkisi olmadığını, D2 operatör akışı ile D3–D4'ün açık kaldığını, R-A/R-B ayrımını, TR-01'in yalnızca yerel **LOCAL PASS** olduğunu ve TR-02–TR-05'in **NOT RUN** kaldığını doğrulayın; bağlantılar, exact-head CI ve bağımsız doküman review tamamlanmalı.

**HOLD (2026-10-26 güncellemesi):** D1 pilot kapsamı ve D2 güven sınırı belirlenmiştir; **D2 operasyonel sorumluluk kararı [2026-10-26'da verildi](https://github.com/kefyusuf/search-memory-mcp/issues/83#issuecomment-6425870367)**; ancak **D3–D4 hâlâ OPEN**. Bu karar, [test tasarımı dokümanındaki](2026-10-13-p0-02-restore-authorization-test-design.md) dört karar alanının D2 cevaplarıyla güncellenmesinin ve tasarım kabulünün ardından **TR-03/TR-04/TR-05 sentetik test implementasyonunu** açar (ayrı PR, sentetik fixture, deploy yok). Depolama migration'ı, restore aracı, **R-B kapsamındaki seçmeli tenant export/restore**, hosted pilot veya canlı veriyle çalışma bu kapılar ayrıca açılmadan başlatılmaz. Bu HOLD, P0-06 kullanıcı verisi silme/export, retention ve graph temizliği yükümlülüklerini kapsamaz; bu işler kendi ayrı kabul kapılarına tabidir.

**P0-02 / L3 sonucu:** **NO-GO değişmedi.** Bu dosyanın birleşmesi P0-02 tamamlandı, DR sertifikalandı veya public L3 yetkilendirildi anlamına gelmez.
