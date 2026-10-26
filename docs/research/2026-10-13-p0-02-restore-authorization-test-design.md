# P0-02 — Tenant restore / revocation test tasarımı (uygulama değil)

**Tarih:** 2026-10-13 · **Kaynak `main`:** [`df3b544`](https://github.com/kefyusuf/search-memory-mcp/commit/df3b544121e9a97cf0c6919bc16e5fdeda5e2eb3) · **Durum:** DESIGN-ONLY / HOSTED NO-GO
**Durum güncellemesi (2026-10-26):** D2 operatör kararı [issue #83'te onaylandı](https://github.com/kefyusuf/search-memory-mcp/issues/83#issuecomment-6425870367); aşağıdaki dört karar alanı D2 cevaplarıyla işlendi ve **TR-03/TR-04/TR-05 sentetik test implementasyonu ayrı PR'da açıldı** (sentetik fixture, deploy yok). **TR-02 HOLD (R-B); hosted restore ve L3 NO-GO** değişmedi.

## Karar sınırı

Bu, birleşen [P0-02 kanıt envanterindeki](2026-10-13-p0-02-hosted-recovery-evidence-gate.md) **yalnızca tenant-scope restore ve iptal edilmiş üyeliğin geri gelmemesi** boşluklarını test edilebilir hale getiren sonraki ayrı iş birimidir (özellikle senaryo 3, 6 ve 7). Bu belgenin kendisi test uygulaması, kurtarma prosedürü veya ürün kararı değildir.

**Dahil:** Sentetik fixture, beklenen değişmezler, negatif senaryolar, testlerin çalıştırılabilmesi için ön koşullar ve ayrı karar eşiği.  
**Hariç:** TypeScript/test kodu, SQLite/PostgreSQL migration, depolama teknolojisi seçimi, tenant export/restore endpoint'i veya komutu, production yetki/administration akışı, Docker/CI değişikliği, gerçek kullanıcı verisi, versiyon/release ve public L3 pilotu.

## Eldeki kanıt; buraya taşınmayan iddialar

- [Yerel online backup regresyonu](../../src/__tests__/sqlite-backup-restore.test.ts), dört SQLite store'un aynı fiziksel dosyadan **yazımlar durdurulmuşken** bağımsız dosyaya restore edildiğini ve sorgulanabildiğini kanıtlar. Bir tenant'ı seçerek geri yüklemez; WAL ile ana dosya kopyasının farkını da gösterir. [Sınırlar](../sqlite-backup-restore.md).
- [Scoped cache regresyonu](../../src/__tests__/workspace-cache.test.ts), aynı URL/ID ile tenant/workspace izolasyonu ve yerel legacy kayıt sınırını sınar. Bu sonuç **backup/restore sırasında** yetki izolasyonu kanıtı değildir.
- [`request-context.ts`](../../src/runtime/request-context.ts) hosted context için doğrulanmış yetki/membership akışı ve kontrol noktaları sunar; local context ayrı, güvenilen stdio yoludur. [HTTP auth](../../src/runtime/hosted-http-auth.ts) bir factory/callback sınırıdır; çalışan public hosted server değildir.
- [PostgreSQL identity modeli](../../migrations/0001-hosted-membership.sql) ve [transactional audit şeması](../../migrations/0002-hosted-membership-audit.sql), uygulama verisinden **ayrı** bir prototiptir. [Mevcut doğrulama](../hosted-membership.md) üyelik/audit rollerini kapsar; iki sistemin eşzamanlı restore ve revocation güvenliğini kapsamaz.

## Hedef kabul değişmezleri (bugün kanıtlanmış sayılmaz)

**I-1 — Scope izolasyonu (hedef):** İleride A1 için tenant/workspace-seçmeli restore onaylanırsa A2/B1 verisi hedefte değişmez, A1 çağıranına açılmaz ve A1 kapsamına taşınmaz. Güvenilir backup operatörünün fiziksel SQLite imajındaki bütün scope'ları okuyabilmesi bu uygulama-seviyesi izolasyondan ayrı bir yetki sınırıdır; fiziksel dosya backup'ı zaten tenant-seçmeli değildir.

**I-2 — Yetki geriye gitmez:** Restore anında geçerli otorite tarafından iptal edilmiş üyelik, daha eski backup'ta etkin olsa bile yeniden yetki kazandıramaz. Tarihsel audit kaydı geçerli authorization state yerine kullanılmaz.

**I-3 — Belirsizlikte fail closed:** Membership/revocation otoritesi kullanılamazsa veya backup/scope doğrulanamazsa restore yayımlanmaz, hosted erişim verilmez, etkin kaynak korunur.

**I-4 — Açık yerel sınır:** Hosted restore doğrulaması local/legacy trusted context'e geri düşmez. Fiziksel SQLite dosya kopyası tek başına tenant-filtered export kabul edilmez.

## Gelecekteki sentetik test veri seti

- Tenant `A`, workspace `A1` ve `A2`; tenant `B`, workspace `B1`. Farklı scope'larda aynı cache URL'si, semantic giriş ID'si, graph doc ID'si ve arama terimi denenir. KnowledgeIndex belge ID'leri global UUID, session note ID'leri de uygulama tarafından üretilir; bu iki store'da aynı ID'nin farklı scope'larda üretildiği varsayılmaz. Her scope'a ayırt edilebilir memory note, knowledge document/chunk, graph entity/link ve cache girdisi yazılır.
- `alice` için `A1` üyeliği snapshot `S0` anında aktif, `S1` anında iptal edilmiş; `bob` için `B1` üyeliği aktif tutulur. Audit kayıtları ayrı PostgreSQL prototipindedir.
- `S0` ve `S1` sentetik fixture isimleridir; ürünümüzde bugün çalışan snapshot koordinasyonu veya tenant import/export API'si bulunduğunu ima etmez. Fixture gerçek token, müşteri verisi, üretim DB'si veya sır içermez.

## Kabul senaryoları — TR-01 yerel kanıt, TR-02–05 henüz çalıştırılmadı

| ID | Test girişi / eylem taslağı | Zorunlu olumlu ve olumsuz kanıt | Durum |
| --- | --- | --- | --- |
| TR-01 | `A1`, `A2`, `B1` aynı dosyada iken bugünkü fiziksel SQLite backup'ını incele | Bütün scope'ların fiziksel imajda bulunabileceği açıkça kabul edilmeli; bunu tenant `A` export'u diye adlandıran tasarım **reddedilmeli** | **LOCAL PASS / PR #79** — A1/A2/B1 aynı SQLite fiziksel yedeğinden dört store ile geri okunur; [test](../../src/__tests__/sqlite-backup-restore.test.ts), [CI #38607983193](https://github.com/kefyusuf/search-memory-mcp/actions/runs/38607983193); tenant export ve hosted restore **YOK** |
| TR-02 | Gelecekteki ayrı ve yetkili A1-restore işlemini A2/B1 ile çakışan cache/graph anahtarları ve ayrı knowledge/memory ID'leri üzerinde dene | Yalnızca A1 hedef verisinin beklenen restore sonucu değişir; A2/B1 içerikleri, sayımlar ve erişim görünürlüğü değişmez; A1 çağıranına yetkisiz veri ifşası veya yazım olmaz | **YOK — restore mekanizması tanımlı değil** |
| TR-03 | `S0` eski identity/data snapshot'ı, `S1`'de iptal edilen `alice/A1` üyeliğiyle karşılaştır | Eski üyelik veya stale token access kazandıramaz; güncel yetki kontrolü deny verir; audit ve revocation tutarlılığı bağımsız doğrulanır | **YOK — otorite/fencing politikası tanımlı değil** → 2026-10-26: D2 kararıyla otorite tanımlandı (canlı Postgres fixture = otorite); sentetik test implementasyonu ayrı PR'da açıldı, **RUN sonucu bekleniyor** |
| TR-04 | Restore doğrulamasında identity otoritesini ulaşılamaz yap; ayrıca yarım/bozuk restore fixture'ı kullan | Belirsiz veya bozuk hedef etkin kullanıma açılmaz; erişim deny olur; orijinal aktif veri ve B1 etkilenmez | **YOK — publish/rollback sınırı tanımlı değil** → 2026-10-26: fail-closed sınırı sentetik matris için tanımlandı (yayın noktası yok); implementasyon aynı PR'da, **RUN sonucu bekleniyor** |
| TR-05 | Hosted istek sırasında local/legacy scope'lu backup veya sahte request context sun | Hosted tarafta local fallback, forged context ve scope aşımı reddedilir; geçerli tenant yalnızca kendi restore edilmiş verisine erişebilir | Mevcut runtime izolasyon testleri var; **restore özelinde YOK** → 2026-10-26: restore-spesifik sentetik testler aynı PR'da açıldı, **RUN sonucu bekleniyor** |

## Testlerin açılabilmesi için karar kapıları (2026-10-26: D2 kararıyla cevaplandı)

1. **Yetki sahibi ve kaynak — CEVAPLANDI ([D2 karar kaydı](https://github.com/kefyusuf/search-memory-mcp/issues/83#issuecomment-6425870367)):** Restore'u **talep eden** = ajan oturumu (kayıtlı istekle); **onaylayan** = repository owner hesabı (insan, 2FA); **yürüten** = onay sonrası ajan; **bağımsız doğrulama** = CI + verifier scriptleri. *Authoritative current membership/revocation kaydı* = **restore sınırının dışındaki canlı PostgreSQL identity DB'si** — asla restore edilmiş snapshot, eski audit, token claim'i veya local stdio context değil. Audit'i bağımsız doğrulayan = CI'daki audit verifier'ı. *Test karşılığı:* sentetik senaryolarda "güncel otorite" = S1 durumdaki canlı Postgres fixture'ı; restore edilen eski membership tablosu hiçbir zaman otorite sayılmaz.
2. **Veri geri yükleme sınırı — CEVAPLANDI (D1 ile):** Tenant/workspace-seçmeli restore **desteklenmeyecek** (R-B HOLD, TR-02 kapsam dışı). Matris yalnızca R-A: tam ortam kurtarması — bütün scope'lar aynı fiziksel yedekte, boş izole hedefe. Scope mapping/çakışma davranışı seçilmedi ve gerekmiyor; fiziksel dosya backup'ı tenant export olarak sunulmaz (I-4).
3. **Sıralama ve kesintide davranış — CEVAPLANDI (sentetik matris için):** Sıra = uygulama-store restore tamamlanır → bütünlük doğrulanır → **yetki doğrulaması her zaman canlı (restore edilmemiş) authority fixture'ına karşı** yapılır. Read/write fencing = restore hedefi testte hiçbir hosted trafiğe açılmaz (yayın noktası yok; D4 OPEN kalır). Yarıda kalma/tekrar = TR-04'ün failure-injection senaryoları; belirsizlikte **fail closed** (I-3), aktif kaynak korunur.
4. **Test kanıtı — değişmedi:** Ayrı, onaylı sentetik test PR'ında her TR-ID için gerçek komut/test kimliği, hedef revizyon, expected/actual, CI bağlantısı ve failure-injection sonucu kaydedilir. Çok-scope **TR-01 yerel sentetik regresyonu** [PR #79](https://github.com/kefyusuf/search-memory-mcp/pull/79) üzerinde CI #38607983193 ile **PASS**; TR-02 **HOLD/NOT RUN**; TR-03–TR-05 implementasyonu bu kararla ayrı PR'da açıldı. TR-01, gerçek hosted recovery, ayrı PostgreSQL identity/audit restore'u veya güncel revocation kanıtı yerine geçmez.

## Bu PR'ın tamamlanması ve karar

**PASS (yalnızca tasarım):** Bu tek Markdown dosyasının kaynakları, olumsuz iddiaları, test kapsamı ve göreli bağlantıları bağımsız incelenir; exact-head CI doğrulanır. Başka dosya, test, kod veya konfigürasyon değiştirilmez.

**GO (2026-10-26 güncellemesi):** D2 operatör kararı [(issue #83)](https://github.com/kefyusuf/search-memory-mcp/issues/83#issuecomment-6425870367) ile yukarıdaki dört karar alanı cevaplandı; bu tasarımın kapsadığı **TR-03/TR-04/TR-05 sentetik testlerinin ayrı bir PR'da implementasyonu yetkilendirildi**. **NO-GO sürer:** P0-02 migration, hosted tenant restore, canlı DR garantisi, public L3 pilotu ve release. Bu belgenin ilk merge'i TR-01–05 testlerinin çalıştırıldığı anlamına gelmemişti; sonradan eklenen **TR-01 yerel test kanıtı** yalnızca fiziksel SQLite kapsamını doğrular. **TR-02 HOLD/NOT RUN; hosted restore ve L3 NO-GO** kalır.
