# ADR-0006: Provisioning API ve pilot kimliği — kendi imzamızın token'ı, IdP ertelenmiş

Status: accepted (2026-10-29, Faz C kapsamı). Refines ADR-0005's provisional identity decision for the hosted pilot.

## Bağlam

Hosted pilot (5 davetli kullanıcı) için kullanıcı kimliği gerekiyor: token'ların güvenilir bir issuer tarafından imzalanması, tenant izolasyonunun bağlanacağı principal/workspace eşlemesi ve iptalin çalışması. [Yetki/kapsam kapısındaki](../research/2026-10-13-p0-02-recovery-authority-scope-gate.md) D2-K3 kuralı, restore yetkisi için geçerlidir; kullanıcı token'larının kimlik kaynağı ayrı bir karardır. ADR-0005 issuer'ı pluggable bırakmıştı (provisional).

Proje açık kaynak ve tek bakımcılıdır; local stdio kullanıcıları için kimlik zaten yoktur. Hosted pilot için ücretli/yönetilen bir servis zorunlu kılmak bu doğaya aykırıdır.

## Karar

1. **Pilot kullanıcı token'ları hosted sunucunun kendi anahtarıyla imzalanır:** ES256 (varsayılan; RS256/EdDSA da destekli), `HOSTED_TOKEN_PRIVATE_KEY_FILE` (PKCS#8) ile imza, `HOSTED_PUBLIC_KEY_FILE` ile doğrulama — operatör anahtar çifti üretir, sunucu eşleşmeyi başlangıçta doğrular. Sıfır dış bağımlılık, sıfır maliyet.
2. **Provisioning, ayrı bir admin HTTP yüzeyinden yapılır** (`HOSTED_ADMIN_PORT` verilirse aktif; verilmezse yüzey hiç açılmaz): `Authorization: Bearer <HOSTED_ADMIN_TOKEN>` ile kimliklenen JSON uçları — workspace oluşturma, üyelik verme/iptal, listeleme ve **pilot token mint** uçları. Operatör token'ı kullanıcı JWT'lerinden fiziksel olarak ayrıdır (farklı port, farklı kimlik türü); kullanıcı JWT'leri admin yüzeyinde asla kabul edilmez.
3. **Veritabanı erişim ayrımı:** admin yüzeyi identity tablolarına **operator DSN** (DML yetkili rol) ile bağlanır; MCP ingress yalnızca reader rolünü kullanır. Rol ayrımı [hosted-membership audit](../hosted-membership-audit.md) dokümanındaki tanımla birebir aynıdır; tüm provisioning değişiklikleri mevcut audit trigger'larıyla otomatik kaydedilir (D2-K4'ün provisioning kaydı bu kanaldan sağlanır).
4. **Tenant modeli:** workspace oluşturulurken `tenantId` verilmezse `workspaceId` kullanılır (varsayılan: bir workspace = bir tenant); birden çok workspace'i tek tenant'ta gruplamak isteyen çağıran açıkça `tenantId` verir.

## Ertelemeler (bilinçli)

- **Gerçek IdP/OAuth ertelendi:** yönetilen OAuth'un ücretsiz kademeleri, self-hosted Zitadel/Keycloak seçenekleri belgelenmiştir; JWT adapter issuer-pluggable olduğu için geçiş araçlara dokunmadan yapılabilir. Pilot token'ları gerçek OAuth deneyimi değildir; davetli sentetik/pilot kapsamı içindir.
- Şifre sıfırlama, kullanıcı self-servis kaydı, e-posta doğrulama, oturum devri — bunlar IdP kararına aittir.
- Admin yüzeyinde rate limit — sonraki dilim (admin token gizliliği birincil kontroldür).

## Güvenlik sınırı

- Admin token repoya girmez; sızarsa rotasyon = env değişimi + yeniden başlatma.
- Admin yüzeyi **asla** hosted araç token'larını veya kullanıcı JWT'lerini doğrulamaz; kullanıcı JWT'leri yalnızca MCP ingress portunda doğrulanır.
- Provisioning değişiklikleri audit tablolarına otomatik yazılır; operator DSN'in `SESSION_USER` değeri audit'in aktör alanına gerçek operatörü işler.
- Kapı durumları değişmez: D2-E1–E5, D3-V3/V4, D4 gerçek karşılıklar OPEN; TR-02 HOLD; **P0-02 kısmi; public L3 NO-GO**. Bu ADR bir hosted pilot onayı değildir.
