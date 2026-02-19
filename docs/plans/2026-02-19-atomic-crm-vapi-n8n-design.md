# AtomicCRM — VAPI + n8n + Supabase Entegrasyon Tasarımı

**Tarih:** 2026-02-19
**Hedef:** Demo + Öğrenme (full pipeline odaklı)
**Kapsam:** Lead Qualification + Teklif Takibi + SLA Eskalasyonu

---

## 1. Hedefler

- VAPI voice AI + n8n orkestrasyon + Supabase veri katmanını entegre etmek
- Ses kayıtlarını Supabase Storage'a aktarmak ve AtomicCRM UI'da göstermek
- Dialog tree tabanlı tutarlı konuşma akışları kurmak
- Telegram bildirimleriyle operasyonel görünürlük sağlamak
- Satış/demo showcase + stack öğrenimi

---

## 2. Mimari Genel Bakış

```
[VAPI Workflow (Dialog Tree)]
    │ arama sırasında Function Calling
    ▼
[Supabase Edge Function]  ←→  [Supabase PostgreSQL]
    │
    │ arama bitti → end-of-call-report webhook
    ▼
[n8n Orchestrator]
    ├── recording URL indir → Supabase Storage'a yükle
    ├── transcript + summary + sentiment → crm_call_logs
    ├── CRM kaydını güncelle (opportunity / quote / ticket)
    └── Telegram bildirimi gönder
         │
         └── [Telegram Bot]

[AtomicCRM UI]
    └── crm_call_logs + Supabase Storage → Audio Player + Aksiyon Butonları
```

### Bileşenler

| Bileşen | Rol |
|---------|-----|
| VAPI Workflows | Dialog tree (node-based conversation flow) |
| VAPI artifactPlan | Ses kaydı (wav), transcript, summary otomatik üretimi |
| VAPI Function Calling | Arama sırasında Supabase'den canlı veri çekme/yazma |
| Supabase Edge Function | VAPI function call endpoint'i (get/update CRM) |
| Supabase Storage | Ses kayıtları (crm-recordings bucket) |
| Supabase PostgreSQL | crm_call_logs tablosu |
| n8n | end-of-call-report işleme, orkestrasyon, Telegram |
| Telegram Bot | Operasyonel bildirimler |
| AtomicCRM UI | Audio player, aksiyon butonları, arama geçmişi |

---

## 3. VAPI Dialog Tree'leri (Workflows)

VAPI Workflows — node-based, deterministik dialog tree:
- **Conversation Node:** Konuşma başlatma, değişken çıkarma
- **API Request Node:** Supabase Edge Function'a HTTP çağrı
- **Transfer Call Node:** Başka numaraya/asistana yönlendirme
- **End Call Node:** Aramayı sonlandırma
- **Global Node:** Her yerden erişilebilir (eskalasyon, callback)

### Flow 1 — Lead Qualification

```
Start Node
  "Merhaba {lead_name}, {şirket} adına arıyorum..."
      │
      ▼
API Request Node ──► get_lead_info(contact_id)
      │                Supabase: isim, şirket, kaynak, notlar
      ▼
Conversation Node (BANT framework)
  Budget / Authority / Need / Timeline
      │
      ├── [Qualified]     ──► API: opportunity.status = 'qualified'
      │                        + End Node
      ├── [Not interested]──► API: status = 'disqualified', reason kayıt
      │                        + End Node
      └── [Callback]      ◄── Global Node (her adımdan erişilebilir)
                               API: reschedule_call(contact_id, datetime)
                               + End Node
```

**Diyalog tutarlılığı:**
- Squads ile BANT her sorusu ayrı asistana bölünebilir
- Context engineering: `userAndAssistantMessages` ile geçmiş taşınır
- `successEvaluationPrompt`: "Müşteri budget açıkladı mı? Karar verici mi?"

### Flow 2 — Teklif Takibi

```
Start Node
  "Teklif #{quote_no} için arıyorum, {geçerlilik_tarihi} sona eriyor..."
      │
      ▼
API Request Node ──► get_quote_details(quote_id)
      │                Supabase: tutar, ürün, geçerlilik, müşteri
      ▼
Conversation Node (karar al)
      │
      ├── [Kabul]         ──► API: quote.status = 'accepted'
      │                        + End Node (teşekkür)
      ├── [Ret]           ──► capture: rejection_reason
      │                        API: status = 'rejected', reason kaydedildi
      │                        + End Node
      ├── [Revizyon]      ──► capture: revision_feedback
      │                        API: status = 'revision_requested'
      │                        + End Node
      └── [Yöneticiyle]  ◄── Global Node
             Transfer Call Node ──► satış yöneticisi numarası
```

### Flow 3 — SLA Eskalasyonu

```
Start Node (urgent, kısa ve net ton)
  "Acil: #{ticket_no} SLA ihlalinde, {gecikme_saat} saat gecikti..."
      │
      ▼
API Request Node ──► get_ticket_details(ticket_id)
      │                Supabase: müşteri, konu, öncelik, geçen süre
      ▼
Conversation Node
      │
      ├── [Üstleniyorum]  ──► API: ticket.escalated = true
      │                        API: ticket.assignee güncelle
      │                        + End Node
      ├── [Devret]        ──► Transfer Call Node (yedek sorumlu)
      └── [Acil]         ◄── Global Node
             Transfer Call Node ──► +90xxx eskalasyon hattı
```

---

## 4. VAPI artifactPlan Konfigürasyonu

```json
{
  "artifactPlan": {
    "recordingEnabled": true,
    "recordingFormat": "wav;l16",
    "transcriptPlan": { "enabled": true },
    "loggingEnabled": true
  },
  "analysisPlan": {
    "summaryPrompt": "Bu aramayı 2-3 cümlede özetle. Müşteri tutumu ve sonuç neydi?",
    "structuredDataSchema": {
      "type": "object",
      "properties": {
        "outcome": { "type": "string" },
        "sentiment": { "type": "string", "enum": ["positive", "neutral", "negative"] },
        "next_action": { "type": "string" },
        "key_objection": { "type": "string" }
      }
    },
    "successEvaluationPrompt": "Arama hedefine ulaştı mı?",
    "successEvaluationRubric": "PassFail"
  }
}
```

---

## 5. Ses Kaydı Aktarım Akışı

```
1. VAPI: arama bitti → end-of-call-report webhook → n8n
2. n8n: call.artifact.recording.url oku
3. n8n: HTTP GET → wav dosyası indir (binary)
4. n8n: Supabase Storage'a yükle
         bucket: crm-recordings
         path: {flow_type}/{YYYY-MM-DD}/{vapi_call_id}.wav
5. n8n: crm_call_logs tablosuna yaz:
         recording_url: https://<supabase>/storage/v1/object/public/crm-recordings/...
         transcript: call.artifact.transcript
         summary: call.analysis.summary
         structured_data: call.analysis.structuredData
         sentiment: structured_data.sentiment
         outcome: structured_data.outcome
         ended_reason: call.endedReason
         duration_sec: call.endedAt - call.startedAt
```

**Not:** VAPI kayıtları 14 gün sonra silinir. n8n aktarımı **anlık** çalışmalı.

---

## 6. Supabase Veri Modeli

### Yeni Tablo: crm_call_logs

```sql
CREATE TABLE crm_call_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CRM bağlantıları (nullable)
  contact_id      uuid REFERENCES contacts(id),
  opportunity_id  uuid REFERENCES opportunities(id),
  quote_id        uuid REFERENCES quotes(id),
  ticket_id       uuid REFERENCES tickets(id),
  -- VAPI meta
  vapi_call_id    text UNIQUE NOT NULL,
  flow_type       text NOT NULL
                    CHECK (flow_type IN ('lead_qualification','quote_followup','sla_escalation')),
  status          text NOT NULL DEFAULT 'initiated'
                    CHECK (status IN ('initiated','completed','no_answer','failed','voicemail')),
  ended_reason    text,
  duration_sec    integer,
  -- İçerik
  recording_url   text,         -- Supabase Storage public URL
  transcript      text,
  summary         text,         -- call.analysis.summary (Claude Sonnet üretir)
  structured_data jsonb,        -- call.analysis.structuredData
  sentiment       text          CHECK (sentiment IN ('positive','neutral','negative')),
  outcome         text,         -- 'qualified','disqualified','accepted','rejected','escalated','callback'
  success         boolean,      -- call.analysis.successEvaluation (PassFail)
  -- Bildirim
  telegram_sent   boolean DEFAULT false,
  -- Zaman
  called_at       timestamptz,
  created_at      timestamptz DEFAULT now()
);

-- İndeksler
CREATE INDEX ON crm_call_logs (contact_id);
CREATE INDEX ON crm_call_logs (opportunity_id);
CREATE INDEX ON crm_call_logs (quote_id);
CREATE INDEX ON crm_call_logs (ticket_id);
CREATE INDEX ON crm_call_logs (flow_type);
CREATE INDEX ON crm_call_logs (created_at DESC);

-- RLS
ALTER TABLE crm_call_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read" ON crm_call_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY "service_write" ON crm_call_logs FOR ALL TO service_role USING (true);
```

### Supabase Storage

```
Bucket: crm-recordings (public, RLS korumalı)
Path: {flow_type}/{YYYY-MM-DD}/{vapi_call_id}.wav
Retention: kalıcı (VAPI'nin 14 günlük silme politikasına karşı)
```

### Metabase View (Yeni)

```sql
CREATE VIEW v_call_analytics AS
SELECT
  flow_type,
  DATE_TRUNC('day', created_at) AS call_date,
  COUNT(*) AS total_calls,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
  COUNT(*) FILTER (WHERE success = true) AS successful,
  AVG(duration_sec) AS avg_duration_sec,
  COUNT(*) FILTER (WHERE sentiment = 'positive') AS positive_sentiment,
  COUNT(*) FILTER (WHERE telegram_sent = true) AS telegram_notified
FROM crm_call_logs
GROUP BY flow_type, DATE_TRUNC('day', created_at);
```

---

## 7. Supabase Edge Function — VAPI Function Calling Endpoint

```
POST /functions/v1/vapi-crm-bridge

VAPI bu endpoint'i şunlar için çağırır:
  - get_lead_info(contact_id)
  - get_quote_details(quote_id)
  - get_ticket_details(ticket_id)
  - update_opportunity_status(id, status, notes)
  - update_quote_status(id, status, reason)
  - update_ticket_escalation(id, assignee)
  - reschedule_call(contact_id, datetime)

Güvenlik: VAPI HMAC imzası doğrulama
```

---

## 8. n8n Workflow'ları

### Workflow A: end-of-call-report İşleyici
```
Webhook (POST) ← VAPI end-of-call-report
  │
  ├── Ses kaydı indir → Supabase Storage yükle
  ├── crm_call_logs INSERT
  ├── CRM kaydı güncelle (flow_type'a göre)
  └── Telegram bildirimi gönder
```

### Workflow B: Quote Takibi (Scheduled)
```
Her gün 09:00
  → Supabase: süresi yaklaşan/geçen teklifleri çek
  → Her teklif için: VAPI outbound call başlat
  → crm_call_logs INSERT (status: 'initiated')
```

### Workflow C: SLA Monitor (Scheduled)
```
Her 30 dakika
  → Supabase: v_ticket_sla'da breach var mı?
  → Her ihlal için: VAPI outbound call başlat
  → crm_call_logs INSERT (status: 'initiated')
```

### Workflow D: Lead Qualification Tetikleyici
```
Supabase Webhook → yeni contact INSERT
  → Çalışma saati kontrolü (09:00-18:00)
  → VAPI outbound call başlat
  → crm_call_logs INSERT (status: 'initiated')
```

---

## 9. AtomicCRM UI — Yeni Bileşenler

### Arama Geçmişi Paneli (Her detay sayfasında)

```
┌──────────────────────────────────────────────┐
│  📞 Arama Geçmişi                             │
├──────────────────────────────────────────────┤
│  🟢 Lead Qualification  19 Şub 2026  4:32dk  │
│  Sonuç: Qualified  |  Duygu: Pozitif          │
│  [▶ Dinle] [📄 Transcript] [📋 Özet]          │
│  [✏️ Nota Ekle] [🔁 Tekrar Ara]               │
├──────────────────────────────────────────────┤
│  🔴 Teklif Takibi  17 Şub 2026  2:15dk       │
│  Sonuç: Callback  |  Duygu: Nötr             │
│  [▶ Dinle] [📄 Transcript] [📋 Özet]          │
├──────────────────────────────────────────────┤
│  [+ Yeni Arama Başlat ▾]  [📤 Telegram'a Gönder] │
└──────────────────────────────────────────────┘
```

### Aksiyon Butonları

| Buton | Kaynak | İşlem |
|-------|--------|-------|
| `▶ Dinle` | Supabase Storage `recording_url` | `<audio>` element, inline player |
| `📄 Transcript` | `crm_call_logs.transcript` | Modal, scroll edilebilir |
| `📋 Özet` | `crm_call_logs.summary` | Tooltip veya drawer |
| `✏️ Nota Ekle` | transcript → clipboard | Opportunity/Ticket note'a append |
| `🔁 Tekrar Ara` | VAPI API | Yeni outbound call başlat |
| `📤 Telegram'a Gönder` | n8n webhook | Manuel Telegram push |

---

## 10. Telegram Entegrasyonu

### Bot Kurulumu
- n8n'de Telegram Credentials → Bot Token
- Hedef: CRM ekip grubu + bireysel DM (yönetici)

### Mesaj Formatları

```
📞 ARAMA TAMAMLANDI
Kişi: Ahmet Yılmaz (TechCorp)
Akış: Lead Qualification
Süre: 4:32 dk
Sonuç: ✅ Qualified
Duygu: 😊 Pozitif
Özet: Müşteri SaaS çözümüne ilgi duydu, Q2 bütçesi var,
karar verici kendisi. Demo için randevu istedi.
```

```
🚨 SLA İHLALİ — ACİL
Bilet: #1042 (Ahmet Bey - Login Sorunu)
Gecikme: 4.5 saat
Öncelik: Yüksek
Sorumlu: Mehmet K. ← VAPI ile arandı
Durum: Eskalasyon başlatıldı
```

```
📊 GÜNLÜK ÖZET (19 Şub 2026)
Toplam Arama: 12
✅ Tamamlanan: 9 | ❌ Cevapsız: 3
Lead Qualification: 5 arama → 3 qualified
Teklif Takibi: 4 arama → 2 kabul, 1 ret, 1 callback
SLA Eskalasyon: 3 arama → 3 eskalasyon açıldı
```

---

## 11. Güvenlik

| Konu | Çözüm |
|------|-------|
| VAPI → Edge Function | HMAC imzası doğrulama |
| VAPI → n8n webhook | Bearer token auth |
| n8n → Supabase | Service Role key (env var) |
| Supabase Storage | Private bucket + signed URL (ses dosyaları) |
| Telegram Bot token | n8n credentials store |
| VAPI API key | n8n credentials store |

---

## 12. Uygulama Fazları

### Faz 1 — Temel Altyapı
- [ ] `crm_call_logs` tablosu + RLS
- [ ] `crm-recordings` Supabase Storage bucket
- [ ] Supabase Edge Function (vapi-crm-bridge)
- [ ] n8n: end-of-call-report işleyici

### Faz 2 — Dialog Tree'ler
- [ ] VAPI: Flow 1 — Lead Qualification workflow
- [ ] VAPI: Flow 2 — Teklif Takibi workflow
- [ ] VAPI: Flow 3 — SLA Eskalasyonu workflow
- [ ] artifactPlan + analysisPlan konfigürasyonu

### Faz 3 — Orkestrasyon
- [ ] n8n: Quote takibi scheduled workflow
- [ ] n8n: SLA monitor scheduled workflow
- [ ] n8n: Lead qualification tetikleyici (Supabase webhook)
- [ ] n8n: Telegram bildirimleri

### Faz 4 — AtomicCRM UI
- [ ] crm_call_logs API endpoint'leri
- [ ] Arama geçmişi paneli (React bileşeni)
- [ ] Audio player (Supabase Storage)
- [ ] Aksiyon butonları

### Faz 5 — Analytics
- [ ] `v_call_analytics` Metabase view
- [ ] Metabase: Calls dashboard kartları
- [ ] Günlük Telegram özet workflow

---

## 13. Başarı Kriterleri

- [ ] Outbound arama başlatılıyor ve dialog tree'yi takip ediyor
- [ ] Arama sırasında Supabase'den canlı veri çekiliyor (Function Calling)
- [ ] Ses kaydı Supabase Storage'a aktarılıyor (14dk içinde)
- [ ] Transcript ve özet crm_call_logs'a yazılıyor
- [ ] AtomicCRM'de ses kaydı dinlenebiliyor
- [ ] Aksiyon butonları çalışıyor
- [ ] Telegram bildirimi her arama sonrası gönderiliyor
- [ ] Metabase'de arama analitikleri görüntülenebiliyor
