# P1-03 offline quality set

Etiketli sorgu seti ve offline değerlendirme düzeneği: `node scripts/eval-quality.mjs` (çıktıyı JSON'a yazmak için `--json PATH`).

## Kapsam

- **120 sorgu** (`queries.jsonl`): 80 yerel retrieval + 40 web-structural.
- **Yerel alt küme (80):** 20 dokümanlık paylaşımlı fixture corpus'a (`local-corpus.jsonl`, 10 EN + 10 TR, her dokümanda benzersiz çapa terimler) karşı etiketlenmiş 64 pozitif sorgu (`relevantDocIds`, çoğunda `top1DocId`) ve 16 negatif sorgu (`expectEmpty` — korpusla hiç token çakışmayan konular).
- **Web alt kümesi (40):** yalnızca yapısal etiketler (intent, locale, opsiyonel domain/from_date). **Offline'da skorlanmaz** — canlı web aramasında relevance yargısı için insan etiketi gerekir; bu alt küme gelecekteki canlı değerlendirmenin girdisidir.
- **Split:** ilk 20 yerel sorgu `tuning`, kalanı `test`; web satırları `test`.

## Ölçülenler

`scripts/eval-quality.mjs` 20 dokümanı tek FTS-only `:memory:` KnowledgeIndex'e yükler (embedding yok, ağ yok — deterministik) ve:

- pozitifler için **recall@1/3/5, precision@1/3/5, MRR, nDCG@5** (binary relevance, unique-source düzeyinde) + **top1Accuracy** (`top1DocId` etiketi olanlarda),
- negatifler için **sıfır-isabet kontrolü** (OR arama semantiğinde token çakışması yasak),
- locale kırılımı (EN/TR nDCG@5).

## Sınırlar

- **FTS-only taban çizgisidir:** embedding/hybrid retrieval kalitesini ölçmez (ağ/kurulum gerektirmeden tekrarlanabilir olması için bilinçli tercih).
- Binary relevance'ta nDCG, ilgili dokümanların tamamı top-k içindeyse sıralamayı cezalandırmaz; sıralama duyarlılığı kısmi-bulgu sorgularından gelir.
- Negatifler OR semantiği nedeniyle **tam token-çakışmasız** seçilmelidir; korpusa yeni doküman eklerken negatifler yeniden denetlenmelidir.
- Web alt kümesi için relevance/kanıt doğruluğu ölçümü canlı benchmark'a (P1-04 ve ilerisi) aittir.
- Etiketler sentetik korpusla birlikte tasarlandığından bu set üretim verisi kalitesini temsil etmez; amacı retrieval davranışındaki gerilemeleri yakalamaktır.
