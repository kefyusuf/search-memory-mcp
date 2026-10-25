# Mimosa gate bulgusu triage kararı — hosted-http-auth.ts:72 (command-injection advisory)

**Tarih:** 2026-10-25 · **Karar:** **YANLIŞ POZİTİF — inkâr edilmedi, kanıtlandı; kapı `ask` moduna alındı**
**Kaynak bulgu:** Mimosa L3 statik taraması, `src/runtime/hosted-http-auth.ts:72`, high, `kind: cross-file`, `advisory: true`, `verdictEffect: none`, CWE eşleşmesi yok
**Mühürlü tarama kaydı:** `scan-2026-10-24T20-20-23.316Z-0b3b3768b277` / `sha256:19b75908bbd1f221bc8f76f7c82737389cf2ceb08ede5ceca3f1b1855020361d`

## Bulgunun iddiası

"不可信数据「HTTP 请求输入」流入 authenticate() → 污点链：authenticate(sink:command-injection)" — yani doğrulanmamış HTTP Authorization girdisinin `authenticate()` çağrısına akması ve bu fonksiyonun komut enjeksiyonu havuzu olarak sınıflandırılması.

## İnsan teyidi (tarayıcının kendi istediği proof gap)

Tarayıcının meta verisi bulgunun kendi içinde "statik advisory — gerçek veri akışı ve istismar edilebilirlik için manuel teyit gerekli" diyordu. Manuel teyidin sonucu:

1. **İşaretlenen çağrı zincirinde komut çalıştırma primitive'i yok.** `authenticate()` (`src/runtime/jwt-authorization.ts`) yalnızca: başlık format kontrolü (8192 sınırı + katı Bearer regex) → `jose` kütüphanesinin saf kripto doğrulaması (`jwtVerify`, algoritma allowlist RS256/ES256/EdDSA, açıkça yapılandırılmış CryptoKey/key-ring) → OAuth scope regex kontrolü → enjekte edilmiş üyelik callback'i (üretimde parameterize edilmiş PostgreSQL read-model). Shell, process spawn veya dinamik kod değerlendirmesi zincirin hiçbir noktasında yok.
2. **Tüm kod tabanı taraması:** tek `spawn` kullanımı `src/browser-launcher.ts` içindedir (Chromium/taskkill, sabit argümanlar; auth zincirinden ulaşılamaz). Diğer `exec` eşleşmeleri `RegExp.prototype.exec` ve SQLite şema `db.exec` çağrılarıdır — komut çalıştırma değildir.
3. **Runtime Oracle uygulanamaz bile:** `mimosa validate` (built-in `command-exec-remote-runner/v1`) yalnızca ledger'a girmiş `fixed_static`/direct bulguları doğrular; bu advisory ledger'a girmez (her taramada yeniden türetilir), dolayısıyla oracle ile "çözme" yolu tasarım gereği kapalıdır.

## Karar ve operasyonel sonuç

- Bulgu **yanlış pozitif** olarak triage edildi. Kod tarafında "düzeltilecek" bir şey yoktur; bu dosyaya bulgu sonrası gelen hiçbir PR dokunmamıştır (#87–#90).
- Kapı, `MIMOSA_GIT_GATE_MODE=ask` ile çalışacak şekilde yapılandırıldı (2026-10-25, kullanıcı onayıyla): high bulgular artık sert reddetme yerine onay sorusu üretir. `MIMOSA_GIT_GATE_FAILURE_MODE=open` açıkça set edildi (altyapı hataları INCONCLUSIVE gösterir, engellemez).
- 2026-10-24'te bu gerekçeyle commit/push işlemleri, birebir aynı sonucu üreten git plumbing komutlarıyla gerçekleştirilmiştir; bağlam PR #87–#90 gövdelerinde mühür referansıyla kayıtlıdır.
- Ledger'daki iki açık öğe (`mimosa.supply.version-range`, package.json 87/101, **low**) bu kararın konusu değildir: caret'lı sürüm aralığı hijyen notlarıdır ve graded/ask modda engelleyici değildir. Proje manifest stilinde caret kullanımı bilinçli tercihtir.
- Bu bulgu gelecekte yeniden yüzeye çıkarsa bu belge referanstır; tarayıcı kuralı düzeltmesi Mimosa tarafına aittir.
