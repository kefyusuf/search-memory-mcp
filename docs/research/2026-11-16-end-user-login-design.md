# P0-03 — Hosted end-user login tasarım seçenekleri (uygulama değil)

**Tarih:** 2026-11-16 · **Kaynak `main`:** [`bcc60e2`](https://github.com/kefyusuf/search-memory-mcp/commit/bcc60e2) · **Durum:** DESIGN-ONLY / OPERATÖR KARARI BEKLİYOR

## Karar sınırı

Bu belge, [ADR-0006](../adr/0006-provisioning-and-identity.md)'da bilinçli olarak ertelenen **kullanıcı girişi (end-user login)** kararı için seçenek analizi ve uygulama taslağı içeren **tasarım iş birimidir**. Öncülleri: usage sayaçları dilimi ([PR #121](https://github.com/kefyusuf/search-memory-mcp/pull/121)/[#122](https://github.com/kefyusuf/search-memory-mcp/pull/122)) ve admin yüzeyinin opt-in hız sınırı ([PR #149](https://github.com/kefyusuf/search-memory-mcp/pull/149)).

**Dahil:** üç seçeneğin analizi, tavsiye, seçilen yolun uygulama taslağı, güvenlik notları, operatör karar noktaları.
**Hariç:** TypeScript/SQL kodu (ayrı onaylı PR'de), gerçek IdP kurulumu veya seçimi, self-servis kayıt/şifre sıfırlama/e-posta akışları, staging deploy, release, public L3 (**NO-GO değişmez**).

## Öncüller (2026-11-16 itibarıyla sağlananlar)

- **JWT adapter issuer-pluggable** (ADR-0005 provisional; ADR-0006 kendi imzamız ES256): issuer değişirse araçlara dokunmadan geçiş mümkün.
- **Pilot token'lar operatör tarafından elle mint ediliyor** (admin yüzeyi, bir-kez-gösterim, TTL ≤ 30 gün, permissions membership satırından); revocation → MCP sınırında 403 uçtan uca kanıtlı ([PR #118](https://github.com/kefyusuf/search-memory-mcp/pull/118), verifier).
- **Membership satırları `issuer + principal_id + workspace_id` anahtarlı**; tenant/workspace eşlemesi sunucuya aittir.
- **Admin yüzeyi kullanıcı JWT'lerini asla doğrulamaz** (ADR-0006 güvenlik sınırı) — login ucu admin portuna **konamaz**.
- **MCP ingress'te admission** (concurrency + opt-in rate) ve **admin yüzeyinde opt-in peer throttle** mevcut; ikisinin de kalıbı unit-test + verifier ile pinli.
- Pilot = **5 davetli kullanıcı**; proje normu: sıfır dış bağımlılık, sıfır maliyet, tek bakımcı.

## Sorun

Bugün token alma = operatörün panelde her kullanıcı için elle mint etmesi. Pilot kullanıcı başına aylık yenileme operatör işi; davet akışı bir "kullanıcı girişi" deneyimi değil ve operatör başına yük kullanıcı sayısıyla lineer büyür.

## Seçenekler

**A — Enrollment kodu + server-minted token (self-built, tavsiye edilen).** Operatör admin API'den bir-kez-gösterim enrollment kodu üretir; davetli kullanıcı kodu **public MCP ingress portundaki** auth'sız bir login ucunda tokana çevirir; JWT MCP client config'ine girilir. Kodlar yeni bir `mcp_identity.enrollment_codes` tablosunda hash'li saklanır; audit mevcut trigger kalıbıyla otomatik. Artı: sıfır dış bağımlılık/maliyet, issuer değişmez, revocation/audit kanalları aynen kalır, kod üretimi = operatör onaylı işlem (D2-K2 ruhu). Eksi: credential deposu bizde (hashing/karşılaştırma disiplini gerekir); gerçek OAuth deneyimi değil; token TTL'i dolan kullanıcı yeniden kod ister (pilot için kabul edilebilir).

**B — Yönetilen OAuth (Auth0/Clerk/Google ücretsiz kademeleri).** Artı: gerçek OAuth, şifre akışları devredilmiş, issuer-pluggable geçiş kolay. Eksi: dış servis + hesap + kullanıcı verisi üçüncü tarafa gider; kademe limitleri; tek-bakımcı/sıfır-maliyet normuyla çelişir; 5 kullanıcılı pilot için aşırı.

**C — Self-hosted IdP (Zitadel/Keycloak, Docker).** Artı: standart OIDC, tam akışlar, veri bizde. Eksi: pilot'a ikinci bir sürekli servis (Keycloak ~1 GB RAM), staging karmaşası, tek bakımcıya sürekli operasyon yükü.

## Tavsiye

Pilot için **Seçenek A**. Gerekçe: davetli 5 kullanıcı, sıfır bağımlılık normu, mevcut revocation/audit altyapısının yeniden kullanımı ve issuer-pluggable seam'in L3'te B/C'ye geçişi açık tutması. Seçenek B/C bir ADR-0007 kararında ayrıca değerlendirilir; bu belge onları dışlamaz.

## Seçenek A uygulama taslağı (onaylandığı takdirde)

1. **Migration `0003-hosted-enrollment.sql`:** `enrollment_codes` (code_hash bytea, workspace_id, permissions text[] NULL→default, expires_at, used_at, created_at); 0002'deki SECURITY DEFINER audit trigger + REVOKE ALL + rol grant kalıbı birebir.
2. **Admin uçları:** `POST /admin/enrollments` (kod üretimi, bir-kez-gösterim — token mint kalıbı), `DELETE /admin/enrollments` (iptal). Hash asla listede görünmez.
3. **Ingress login ucu:** public MCP portunda `POST /login` — auth'sız ama **strict peer throttle** (admin limiter kalıbı) + admission altında; kod scrypt hash + `timingSafeEqual` doğrulanır; `UPDATE ... WHERE used_at IS NULL RETURNING` ile tek kullanım yarış-güvenli; başarılı redeem membership satırını doğrular ve ES256 JWT mint eder.
4. **Panel:** operatör paneline "davet kodu üret" bölümü (mint bölümü kalıbı, textContent-only).
5. **Verifier:** `verify-provisioning.mjs`'e bölüm — kod üret → login ucundan token al → tool çağrısı → **ikinci redeem reddi** → süresi/iptali reddedilir.
6. **Env:** mevcut değişkenlere ek olarak yalnızca login throttle ayarı (`HOSTED_LOGIN_RATE_LIMIT`/`HOSTED_LOGIN_RATE_WINDOW_MS`); hosted-env.md güncellenir.

## Güvenlik notları

- Kod = bearer sır: scrypt + tuz ile hash, `timingSafeEqual` karşılaştırma; kod **asla** log/audit'e yazılmaz; üretimde bir-kez-gösterim.
- `/login` auth'sızdır: strict peer throttle + kod alanı dar (uzun rastgele kod) → brute-force yüzeyi minimal; admin throttle ile aynı kalıp, ayrı sayaç.
- Audit: enrollment create/redeem/revoke `membership_audit` kalıbıyla; `SESSION_USER` aktör alanı operatör/kullanıcı ayrımını taşır.
- K3 uyumu: kullanıcı kimlik kaynağı, restore yetkisinden bağımsızdır (D2 karar kartı ayrımı değişmez).

## Operatör kararları (KARAR GEREKLİ)

1. **Seçenek:** A / B / C (tavsiye: A).
2. **Enrollment kodu:** tek kullanımlık mı, N kullanımlık mı; TTL? (tavsiye: tek kullanımlık, 7 gün)
3. **Enrolled token TTL:** 7 / 30 gün? (tavsiye: 30 gün — aylık operatör yükü minimum; davetli pilot)
4. **Login ucu konumu:** public MCP ingress portu (tavsiye: tek port, admission paylaşır) mı, ayrı port mu?
5. **Enrollment permission seti:** `DEFAULT_PERMISSIONS` (tavsiye) mı, kod başına daraltma mı?
6. **Login throttle varsayılanı:** kapalı (opt-in, admin throttle ile aynı) mı, ingress için makul bir default mı?

## PASS / GO / NO-GO

- Bu belge tek başına GO değildir: uygulama PR'i, operatör karar kaydındaki seçenek ve parametrelerle sınırlı onaylanır.
- Public L3 **NO-GO değişmez**; staging deploy (ADR-0005) ayrı iş birimidir.
