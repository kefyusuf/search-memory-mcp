# P0-02 — Tenant restore / revocation test tasarımı (uygulama değil)

**Tarih:** 2026-10-13 · **Kaynak `main`:** [`df3b544`](https://github.com/kefyusuf/search-memory-mcp/commit/df3b544121e9a97cf0c6919bc16e5fdeda5e2eb3) · **Durum:** DESIGN-ONLY / HOSTED NO-GO

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

**I-1 — Scope izolasyonu:** Tenant A için geri yükleme işlemi, B'ye veya A içindeki başka workspace'e ait satır, ID, içerik, vektör, not ve graph linklerini okumaz/değiştirmez. Aynı mantıksal ID ve URL'nin farklı scope'larda bulunması korumayı delmez.

**I-2 — Yetki geriye gitmez:** Restore anında geçerli otorite tarafından iptal edilmiş üyelik, daha eski backup'ta etkin olsa bile yeniden yetki kazandıramaz. Tarihsel audit kaydı geçerli authorization state yerine kullanılmaz.

**I-3 — Belirsizlikte fail closed:** Membership/revocation otoritesi kullanılamazsa veya backup/scope doğrulanamazsa restore yayımlanmaz, hosted erişim verilmez, etkin kaynak korunur.

**I-4 — Açık yerel sınır:** Hosted restore doğrulaması local/legacy trusted context'e geri düşmez. Fiziksel SQLite dosya kopyası tek başına tenant-filtered export kabul edilmez.

## Gelecekteki sentetik test veri seti

- Tenant `A`, workspace `A1` ve `A2`; tenant `B`, workspace `B1`. Aynı doküman ID, cache URL, semantic giriş ID'si ve arama terimi farklı scope'larda bulunur. Her scope'a ayırt edilebilir memory note, knowledge document/chunk, graph entity/link ve cache girdisi yazılır.
- `alice` için `A1` üyeliği snapshot `S0` anında aktif, `S1` anında iptal edilmiş; `bob` için `B1` üyeliği aktif tutulur. Audit kayıtları ayrı PostgreSQL prototipindedir.
- `S0` ve `S1` sentetik fixture isimleridir; ürünümüzde bugün çalışan snapshot koordinasyonu veya tenant import/export API'si bulunduğunu ima etmez. Fixture gerçek token, müşteri verisi, üretim DB'si veya sır içermez.

## Henüz çalıştırılmamış kabul senaryoları

| ID | Test girişi / eylem taslağı | Zorunlu olumlu ve olumsuz kanıt | Durum |
| --- | --- | --- | --- |
| TR-01 | `A1`, `A2`, `B1` aynı dosyada iken bugünkü fiziksel SQLite backup'ını incele | Bütün scope'ların fiziksel imajda bulunabileceği açıkça kabul edilmeli; bunu tenant `A` export'u diye adlandıran tasarım **reddedilmeli** | Fiziksel backup kanıtlı; tenant export **YOK** |
| TR-02 | Gelecekteki ayrı ve yetkili A1-restore işlemini A2/B1 ile çakışan ID/URL verileri üzerinde dene | Yalnızca A1 hedef verisinin beklenen restore sonucu değişir; A2/B1 içerikleri, sayımlar ve erişim görünürlüğü değişmez; yetkisiz okuma/yazma sıfır | **YOK — restore mekanizması tanımlı değil** |
| TR-03 | `S0` eski identity/data snapshot'ı, `S1`'de iptal edilen `alice/A1` üyeliğiyle karşılaştır | Eski üyelik veya stale token access kazandıramaz; güncel yetki kontrolü deny verir; audit ve revocation tutarlılığı bağımsız doğrulanır | **YOK — otorite/fencing politikası tanımlı değil** |
| TR-04 | Restore doğrulamasında identity otoritesini ulaşılamaz yap; ayrıca yarım/bozuk restore fixture'ı kullan | Belirsiz veya bozuk hedef etkin kullanıma açılmaz; erişim deny olur; orijinal aktif veri ve B1 etkilenmez | **YOK — publish/rollback sınırı tanımlı değil** |
| TR-05 | Hosted istek sırasında local/legacy scope'lu backup veya sahte request context sun | Hosted tarafta local fallback, forged context ve scope aşımı reddedilir; geçerli tenant yalnızca kendi restore edilmiş verisine erişebilir | Mevcut runtime izolasyon testleri var; **restore özelinde YOK** |

## Testlerin açılabilmesi için karar kapıları

1. **Yetki sahibi ve kaynak:** Restore'u kim isteyebilir/onaylayabilir? Current membership/revocation için hangi kayıt *authoritative*? Audit'i kim doğrular? Bunlar kararlaştırılmadan TR-02–05 uygulanabilir test sayılamaz.
2. **Veri geri yükleme sınırı:** Tenant/workspace düzeyinde restore gerçekten desteklenecek mi? Desteklenecekse scope mapping, tutarlı hedef ve çakışma davranışı ayrı kararda tanımlanmalı. Fiziksel dosya backup'ı bu ihtiyaç için otomatik çözüm değildir.
3. **Sıralama ve kesintide davranış:** Ayrı identity ve uygulama depolarında restore sırası, read/write fencing, yarıda kalma/tekrar deneme ve yayına alma noktası tanımlanmalı. Teknik uygulama mekanizması bu belgede seçilmez.
4. **Test kanıtı:** Daha sonra açılabilecek **ayrı, onaylı** sentetik test PR'ında her TR-ID için gerçek komut/test kimliği, hedef revizyon, expected/actual, CI bağlantısı ve failure-injection sonucu kaydedilmeli. Bu belge için tüm TR-02–05 **NOT RUN**.

## Bu PR'ın tamamlanması ve karar

**PASS (yalnızca tasarım):** Bu tek Markdown dosyasının kaynakları, olumsuz iddiaları, test kapsamı ve göreli bağlantıları bağımsız incelenir; exact-head CI doğrulanır. Başka dosya, test, kod veya konfigürasyon değiştirilmez.

**GO:** Ayrı bir karar aşamasında test otoritesi/scope gereksinimleri netleştirilebilir. **NO-GO:** P0-02 migration, hosted tenant restore, canlı DR garantisi, public L3 pilotu ve release **halen onaysızdır**. Bu PR merge edilse bile TR-02–05 geçmiş test olarak gösterilemez.
