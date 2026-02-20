---
name: web-verify-before-claim
description: >
  Harici platform, API, araç veya ürün hakkında özellik, kısıtlama, fiyat veya
  herhangi bir faktüel iddia yapmadan önce WebSearch ile doğrula ve kaynak göster.
  Şu durumlarda ZORUNLU olarak devreye gir:
  - Bir SaaS/platform hakkında "destekliyor" veya "desteklemiyor" iddiası
  - API özelliği, endpoint, limit veya fiyatlandırma hakkında bilgi verme
  - Üçüncü taraf araçlar (VAPI, ElevenLabs, n8n, Supabase, Stripe, Twilio, OpenAI vb.) hakkında teknik detay
  - "Şu an beta/GA/deprecated" gibi ürün durumu bilgisi
  - Rakip karşılaştırması veya özellik matrisi oluşturma
  - Modelin eğitim kesim tarihinden sonra değişmiş olabilecek herhangi bir bilgi
---

# Web Verify Before Claim

## Kural: Önce Ara, Sonra Söyle

Harici bir platform veya araç hakkında faktüel bir iddia yapacaksan:

1. **WebSearch yap** — iddiayı yapmadan önce
2. **Resmi kaynağı bul** — docs, changelog, blog, release notes
3. **Kaynakla birlikte söyle** — `[Başlık](URL)` formatında
4. **Bulamazsan söyle** — "doğrulayamadım, resmi dökümana bak"

## Akış

```
İddia yapmak üzereyim
        ↓
   WebSearch yap
        ↓
  Resmi kaynak bul
        ↓
 Kaynakla birlikte cevap ver
```

## Yasak

- Eğitim verisinden gelen bilgiyi doğrulamadan fact olarak sunma
- "Desteklemiyor" veya "yok" gibi kısıtlama iddiası yapmadan önce aramama
- "Sanırım" ile başlayıp kaynak göstermeden devam etme
- Bilgi kesim tarihi öncesi verileri güncel gibi sunma

## Kaynak Önceliği

1. Resmi dokümantasyon (`docs.platform.com`)
2. Resmi blog / changelog / release notes
3. Resmi GitHub repo (releases, issues)
4. Bulunamazsa: "doğrulayamadım, resmi kaynağa bak" de

## Örnek

> Kullanıcı: "ElevenLabs outbound calling destekliyor mu?"

❌ Yanlış:
> "ElevenLabs şu an sadece inbound/web widget destekliyor, outbound yok."
> *(kaynak yok, doğrulama yok)*

✅ Doğru:
> WebSearch("ElevenLabs outbound calling 2026") → resmi sayfaya bak → cevap:
> "Evet destekliyor: Batch Calling özelliği ile Twilio/SIP üzerinden outbound arama yapılabiliyor.
> [Kaynak: ElevenLabs — Batch Calling](https://elevenlabs.io/blog/introducing-batch-calling-for-elevenlabs-conversational-ai)"

## Platform Örnekleri

Bu listeyle sınırlı değil — herhangi bir 3. taraf araç için geçerli:

VAPI, ElevenLabs, Twilio, OpenAI, Anthropic, n8n, Supabase, Stripe,
AWS, Google Cloud, Azure, Vercel, Netlify, Cloudflare, Dokploy, Metabase,
Telegram Bot API, Resend, Postmark, Linear, Notion, Airtable
