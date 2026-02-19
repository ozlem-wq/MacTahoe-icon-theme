# AtomicCRM VAPI + n8n + Supabase Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** AtomicCRM'e VAPI voice AI entegre ederek lead qualification, teklif takibi ve SLA eskalasyonu aramaları yapan, ses kayıtlarını Supabase'e aktaran, AtomicCRM UI'da gösteren ve Telegram'a bildiren bir sistem kurmak.

**Architecture:** VAPI Workflows (dialog tree) → Supabase Edge Function (function calling) → n8n (end-of-call-report işleme, orkestrasyon) → Supabase Storage (ses kayıtları) + PostgreSQL (crm_call_logs) → AtomicCRM UI (audio player, aksiyon butonları) + Telegram (bildirimler).

**Tech Stack:** VAPI (voice AI, workflows, function calling), n8n (workflow automation), Supabase (PostgreSQL, Storage, Edge Functions / Deno), React (AtomicCRM UI), Telegram Bot API.

**Design Doc:** `docs/plans/2026-02-19-atomic-crm-vapi-n8n-design.md`

---

## Ön Koşullar

```bash
# Gerekli araçlar
supabase --version   # Supabase CLI >= 1.x
curl --version       # HTTP test için
node --version       # >= 18
deno --version       # Edge Function geliştirme için (opsiyonel)
```

**Gerekli credential'lar (n8n Credentials'a ekle):**
- VAPI API Key → `https://app.vapi.ai` → Settings → API Keys
- Supabase Service Role Key → Supabase Dashboard → Settings → API
- Telegram Bot Token → @BotFather → /newbot
- Telegram Chat ID → @userinfobot

---

## FAZ 1: Temel Altyapı

### Task 1: Supabase Migration — crm_call_logs Tablosu

**Files:**
- Create: `supabase/migrations/20260219000001_crm_call_logs.sql`

**Step 1: Migration dosyasını oluştur**

```sql
-- supabase/migrations/20260219000001_crm_call_logs.sql

CREATE TABLE crm_call_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  opportunity_id  uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  quote_id        uuid REFERENCES quotes(id) ON DELETE SET NULL,
  ticket_id       uuid REFERENCES tickets(id) ON DELETE SET NULL,
  vapi_call_id    text UNIQUE NOT NULL,
  flow_type       text NOT NULL
                    CHECK (flow_type IN (
                      'lead_qualification',
                      'quote_followup',
                      'sla_escalation'
                    )),
  status          text NOT NULL DEFAULT 'initiated'
                    CHECK (status IN (
                      'initiated','completed','no_answer',
                      'failed','voicemail'
                    )),
  ended_reason    text,
  duration_sec    integer,
  recording_url   text,
  transcript      text,
  summary         text,
  structured_data jsonb,
  sentiment       text CHECK (sentiment IN ('positive','neutral','negative')),
  outcome         text,
  success         boolean,
  telegram_sent   boolean DEFAULT false,
  called_at       timestamptz,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_call_logs_contact    ON crm_call_logs (contact_id);
CREATE INDEX idx_call_logs_opportunity ON crm_call_logs (opportunity_id);
CREATE INDEX idx_call_logs_quote       ON crm_call_logs (quote_id);
CREATE INDEX idx_call_logs_ticket      ON crm_call_logs (ticket_id);
CREATE INDEX idx_call_logs_flow        ON crm_call_logs (flow_type);
CREATE INDEX idx_call_logs_created     ON crm_call_logs (created_at DESC);
CREATE INDEX idx_call_logs_vapi        ON crm_call_logs (vapi_call_id);

ALTER TABLE crm_call_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_can_read"
  ON crm_call_logs FOR SELECT TO authenticated USING (true);

CREATE POLICY "service_role_full_access"
  ON crm_call_logs FOR ALL TO service_role USING (true);
```

**Step 2: Migration'ı uygula**

```bash
# Supabase CLI ile (self-hosted)
supabase db push

# YA DA doğrudan SQL çalıştır (Supabase Studio veya psql)
psql "postgresql://postgres:<password>@<host>:5432/postgres" \
  -f supabase/migrations/20260219000001_crm_call_logs.sql
```

**Step 3: Tabloyu doğrula**

```sql
-- Supabase SQL Editor veya psql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'crm_call_logs'
ORDER BY ordinal_position;
-- 19 sütun görmeli
```

**Step 4: Commit**

```bash
git add supabase/migrations/20260219000001_crm_call_logs.sql
git commit -m "feat(db): add crm_call_logs table with RLS"
```

---

### Task 2: Supabase Storage — crm-recordings Bucket

**Files:**
- Create: `supabase/migrations/20260219000002_crm_recordings_bucket.sql`

**Step 1: Bucket ve policy migration yaz**

```sql
-- supabase/migrations/20260219000002_crm_recordings_bucket.sql

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'crm-recordings',
  'crm-recordings',
  false,
  52428800,  -- 50MB max per file
  ARRAY['audio/wav','audio/mpeg','audio/mp3','audio/x-wav']
)
ON CONFLICT (id) DO NOTHING;

-- Authenticated kullanıcılar okuyabilir
CREATE POLICY "authenticated_read_recordings"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'crm-recordings');

-- Sadece service_role yazabilir
CREATE POLICY "service_write_recordings"
  ON storage.objects FOR INSERT TO service_role
  WITH CHECK (bucket_id = 'crm-recordings');

CREATE POLICY "service_update_recordings"
  ON storage.objects FOR UPDATE TO service_role
  USING (bucket_id = 'crm-recordings');
```

**Step 2: Uygula ve doğrula**

```bash
# Migration uygula
supabase db push

# Doğrula: Supabase Dashboard → Storage → crm-recordings bucket görünmeli
```

**Step 3: Bucket erişim testi (curl ile)**

```bash
# Service Role key ile dosya listesi
curl -X GET \
  'https://<SUPABASE_URL>/storage/v1/bucket/crm-recordings' \
  -H 'Authorization: Bearer <SERVICE_ROLE_KEY>'
# {"id":"crm-recordings","name":"crm-recordings",...} döner
```

**Step 4: Commit**

```bash
git add supabase/migrations/20260219000002_crm_recordings_bucket.sql
git commit -m "feat(storage): add crm-recordings bucket with RLS policies"
```

---

### Task 3: Supabase Edge Function — vapi-crm-bridge

**Files:**
- Create: `supabase/functions/vapi-crm-bridge/index.ts`

**Step 1: Edge Function iskeletini oluştur**

```bash
mkdir -p supabase/functions/vapi-crm-bridge
```

**Step 2: index.ts yaz**

```typescript
// supabase/functions/vapi-crm-bridge/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

// VAPI HMAC imzası doğrulama
async function verifyVapiSignature(req: Request, body: string): Promise<boolean> {
  const signature = req.headers.get('x-vapi-signature')
  if (!signature) return false
  const secret = Deno.env.get('VAPI_WEBHOOK_SECRET') ?? ''
  if (!secret) return true // geliştirme ortamında atla

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  return signature === expected
}

const handlers: Record<string, (args: Record<string, string>) => Promise<unknown>> = {

  async get_lead_info({ contact_id }) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, email, phone, company_name, source, notes')
      .eq('id', contact_id)
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async get_quote_details({ quote_id }) {
    const { data, error } = await supabase
      .from('quotes')
      .select('id, quote_number, total_amount, currency, valid_until, status, notes, contact:contacts(first_name, last_name, phone)')
      .eq('id', quote_id)
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async get_ticket_details({ ticket_id }) {
    const { data, error } = await supabase
      .from('tickets')
      .select('id, ticket_number, subject, priority, status, created_at, sla_deadline, assignee:profiles(full_name), contact:contacts(first_name, last_name)')
      .eq('id', ticket_id)
      .single()
    if (error) throw new Error(error.message)
    return data
  },

  async update_opportunity_status({ opportunity_id, status, notes }) {
    const { error } = await supabase
      .from('opportunities')
      .update({ status, notes: notes ?? undefined, updated_at: new Date().toISOString() })
      .eq('id', opportunity_id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  async update_quote_status({ quote_id, status, reason }) {
    const { error } = await supabase
      .from('quotes')
      .update({ status, notes: reason ?? undefined, updated_at: new Date().toISOString() })
      .eq('id', quote_id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  async update_ticket_escalation({ ticket_id, assignee_id }) {
    const { error } = await supabase
      .from('tickets')
      .update({ escalated: true, assignee_id: assignee_id ?? undefined, updated_at: new Date().toISOString() })
      .eq('id', ticket_id)
    if (error) throw new Error(error.message)
    return { success: true }
  },

  async reschedule_call({ contact_id, datetime, notes }) {
    const { error } = await supabase
      .from('tasks')
      .insert({
        title: `Follow-up araması — ${datetime}`,
        due_date: datetime,
        contact_id,
        notes: notes ?? 'VAPI: Callback talep edildi',
        status: 'pending'
      })
    if (error) throw new Error(error.message)
    return { success: true, message: `Callback ${datetime} için planlandı` }
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const body = await req.text()

  const valid = await verifyVapiSignature(req, body)
  if (!valid) return new Response('Unauthorized', { status: 401 })

  let payload: { type: string; toolCallList?: Array<{ id: string; function: { name: string; arguments: Record<string, string> } }> }
  try {
    payload = JSON.parse(body)
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  if (payload.type !== 'tool-calls' || !payload.toolCallList?.length) {
    return new Response(JSON.stringify({ results: [] }), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const results = await Promise.all(
    payload.toolCallList.map(async (toolCall) => {
      const handler = handlers[toolCall.function.name]
      if (!handler) {
        return { toolCallId: toolCall.id, result: JSON.stringify({ error: 'Unknown function' }) }
      }
      try {
        const result = await handler(toolCall.function.arguments)
        return { toolCallId: toolCall.id, result: JSON.stringify(result) }
      } catch (err) {
        return { toolCallId: toolCall.id, result: JSON.stringify({ error: String(err) }) }
      }
    })
  )

  return new Response(JSON.stringify({ results }), {
    headers: { 'Content-Type': 'application/json' }
  })
})
```

**Step 3: Edge Function'ı deploy et**

```bash
supabase functions deploy vapi-crm-bridge --no-verify-jwt
```

**Step 4: Lokal test**

```bash
# get_lead_info testi
curl -X POST \
  'https://<SUPABASE_URL>/functions/v1/vapi-crm-bridge' \
  -H 'Authorization: Bearer <ANON_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "tool-calls",
    "toolCallList": [{
      "id": "test-1",
      "function": {
        "name": "get_lead_info",
        "arguments": { "contact_id": "<gerçek_contact_uuid>" }
      }
    }]
  }'
# {"results":[{"toolCallId":"test-1","result":"{\"id\":\"...\",\"first_name\":\"...\"...}"}]}
```

**Step 5: Commit**

```bash
git add supabase/functions/vapi-crm-bridge/
git commit -m "feat(edge): add vapi-crm-bridge function calling endpoint"
```

---

### Task 4: n8n — end-of-call-report Workflow

**Files:**
- Create: `n8n/workflows/vapi-end-of-call-handler.json` (referans)

**Step 1: n8n'de webhook node oluştur**

n8n UI → New Workflow → "VAPI End-of-Call Handler"

Node 1 — **Webhook**
```
Method: POST
Path: vapi-end-of-call
Authentication: Header Auth
Header Name: x-webhook-secret
Header Value: <n8n_webhook_secret>
Response Mode: Immediately
```

Webhook URL: `https://<n8n_url>/webhook/vapi-end-of-call`

**Step 2: Recording İndir → Supabase Storage**

Node 2 — **Code (JavaScript)**
```javascript
// Ses kaydını VAPI'den indir
const artifact = $json.body.artifact || {}
const recordingUrl = artifact.recording?.url || artifact.recordingUrl

if (!recordingUrl) {
  return [{ json: { ...($json.body), recordingDownloaded: false, supabaseRecordingUrl: null } }]
}

const callId = $json.body.call?.id || 'unknown'
const flowType = $json.body.call?.metadata?.flow_type || 'unknown'
const date = new Date().toISOString().split('T')[0]

// İndir
const response = await fetch(recordingUrl)
const buffer = await response.arrayBuffer()
const blob = new Blob([buffer], { type: 'audio/wav' })

// Supabase Storage'a yükle
const storagePath = `${flowType}/${date}/${callId}.wav`
const uploadResponse = await fetch(
  `${process.env.SUPABASE_URL}/storage/v1/object/crm-recordings/${storagePath}`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'audio/wav',
      'x-upsert': 'true'
    },
    body: blob
  }
)

if (!uploadResponse.ok) {
  const err = await uploadResponse.text()
  throw new Error(`Storage upload failed: ${err}`)
}

const supabaseRecordingUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/crm-recordings/${storagePath}`

return [{
  json: {
    ...($json.body),
    recordingDownloaded: true,
    supabaseRecordingUrl,
    storagePath
  }
}]
```

**Step 3: crm_call_logs INSERT**

Node 3 — **Supabase Node** (veya HTTP Request)
```
Operation: Insert Row
Table: crm_call_logs
Columns:
  vapi_call_id:    {{ $json.body.call.id }}
  flow_type:       {{ $json.body.call.metadata.flow_type }}
  contact_id:      {{ $json.body.call.metadata.contact_id || null }}
  opportunity_id:  {{ $json.body.call.metadata.opportunity_id || null }}
  quote_id:        {{ $json.body.call.metadata.quote_id || null }}
  ticket_id:       {{ $json.body.call.metadata.ticket_id || null }}
  status:          {{ $json.body.call.endedReason === 'customer-ended-call' ? 'completed' : $json.body.call.endedReason?.includes('no-answer') ? 'no_answer' : 'completed' }}
  ended_reason:    {{ $json.body.call.endedReason }}
  duration_sec:    {{ Math.round(($json.body.call.endedAt - $json.body.call.startedAt) / 1000) }}
  recording_url:   {{ $json.supabaseRecordingUrl }}
  transcript:      {{ $json.body.artifact.transcript }}
  summary:         {{ $json.body.analysis?.summary }}
  structured_data: {{ JSON.stringify($json.body.analysis?.structuredData) }}
  sentiment:       {{ $json.body.analysis?.structuredData?.sentiment }}
  outcome:         {{ $json.body.analysis?.structuredData?.outcome }}
  success:         {{ $json.body.analysis?.successEvaluation === 'true' }}
  called_at:       {{ $json.body.call.startedAt }}
```

**Step 4: Telegram Bildirimi**

Node 4 — **Telegram Node**
```
Operation: Send Message
Chat ID: {{ process.env.TELEGRAM_CRM_CHAT_ID }}
Text: |
  📞 *Arama Tamamlandı*
  Akış: {{ $json.body.call.metadata.flow_type }}
  Süre: {{ Math.round($json.duration_sec / 60) }}dk {{ $json.duration_sec % 60 }}sn
  Sonuç: {{ $json.outcome || 'Belirsiz' }}
  Duygu: {{ $json.sentiment || '-' }}

  📋 *Özet:*
  {{ $json.body.analysis?.summary || 'Özet mevcut değil' }}
Parse Mode: Markdown
```

**Step 5: Workflow'u aktifleştir ve test et**

```bash
# n8n webhook URL'ini VAPI'ye kaydet (VAPI Dashboard → Settings → Server URL)
# Test: VAPI'den manuel bir arama yap, n8n execution'larını kontrol et
# n8n UI → Executions → son execution → tüm node'lar yeşil olmalı
```

**Step 6: Commit (workflow export)**

```bash
# n8n UI → Workflow → Export → JSON olarak kaydet
# git add n8n/workflows/vapi-end-of-call-handler.json
git commit -m "feat(n8n): add VAPI end-of-call-report handler workflow"
```

---

## FAZ 2: VAPI Dialog Tree'leri

### Task 5: VAPI Asistan Araçlarını (Tools) Tanımla

**Step 1: VAPI Dashboard'a git → Tools → Add Tool**

Her fonksiyon için ayrı Custom Tool oluştur:

**get_lead_info Tool:**
```json
{
  "name": "get_lead_info",
  "description": "CRM'den lead/contact bilgilerini çeker",
  "parameters": {
    "type": "object",
    "properties": {
      "contact_id": { "type": "string", "description": "Supabase contact UUID" }
    },
    "required": ["contact_id"]
  },
  "server": {
    "url": "https://<SUPABASE_URL>/functions/v1/vapi-crm-bridge"
  }
}
```

**Aynı şekilde oluştur:**
- `get_quote_details(quote_id)`
- `get_ticket_details(ticket_id)`
- `update_opportunity_status(opportunity_id, status, notes)`
- `update_quote_status(quote_id, status, reason)`
- `update_ticket_escalation(ticket_id, assignee_id)`
- `reschedule_call(contact_id, datetime, notes)`

**Step 2: Tool ID'lerini kaydet**

```bash
# Her tool oluşturulduktan sonra ID'yi not et
# docs/plans/vapi-tool-ids.md dosyasına ekle (git'e ekleme)
```

---

### Task 6: VAPI Workflow — Lead Qualification

**Step 1: VAPI Dashboard → Workflows → Create Workflow**

İsim: `CRM Lead Qualification`

**Step 2: Node'ları oluştur**

```
Start Node (isim: "Intro"):
  First Message: "Merhaba {{customer_name}}, {{company_name}} adına arıyorum.
    Kısa bir değerlendirme araması için uygun bir vaktiniz var mı?"
  System Prompt: |
    Sen AtomicCRM satış asistanısın. Amacın leadi BANT çerçevesiyle qualify etmek.
    Budget: Bütçe onayı var mı?
    Authority: Karar verici sen misin?
    Need: Bu çözüme ihtiyacın var mı?
    Timeline: Ne zaman karar vereceksin?
    Konuşmayı doğal tut, baskı yapma. Türkçe konuş.
  Tools: [get_lead_info]
  Variable extraction: customer_name, company_name, contact_id

API Request Node (isim: "Fetch Lead"):
  Bağlantı: Start → Fetch Lead
  Tool: get_lead_info
  Input: { "contact_id": "{{contact_id}}" }

Conversation Node (isim: "BANT Qualify"):
  Prompt: Müşteriyi nazikçe qualify et. 4 BANT sorusunu doğal akışta sor.
  Tools: [reschedule_call, update_opportunity_status]
  dataExtractionPlan:
    budget_confirmed: boolean
    is_decision_maker: boolean
    has_need: boolean
    timeline: string
    outcome: enum[qualified, not_interested, callback]

End Node (isim: "Qualified - End"):
  Message: "Harika! Sizi ekibimizle bir demo için randevuya almak istiyorum..."
  Bağlantı koşulu: outcome == 'qualified'
  Tool: update_opportunity_status(status='qualified')

End Node (isim: "Not Interested - End"):
  Message: "Anladım, ilginiz için teşekkür ederim. İyi günler!"
  Bağlantı koşulu: outcome == 'not_interested'
  Tool: update_opportunity_status(status='disqualified')

Global Node (isim: "Callback Handler"):
  Enter condition: "Müşteri sonra aramak istiyor veya uygun zamanı yok"
  Message: "Tabii ki, sizi ne zaman arayalım?"
  Tool: reschedule_call
  → End Node: "Tamam, {{datetime}} için not aldım. İyi günler!"
```

**Step 3: artifactPlan konfigüre et**

```json
{
  "artifactPlan": {
    "recordingEnabled": true,
    "recordingFormat": "wav;l16",
    "transcriptPlan": { "enabled": true }
  },
  "analysisPlan": {
    "summaryPrompt": "Bu satış aramasını 2-3 cümlede özetle. Müşterinin tutumu ve qualify sonucu neydi?",
    "structuredDataSchema": {
      "type": "object",
      "properties": {
        "outcome": { "type": "string", "enum": ["qualified","not_interested","callback"] },
        "sentiment": { "type": "string", "enum": ["positive","neutral","negative"] },
        "key_objection": { "type": "string" },
        "budget_range": { "type": "string" },
        "timeline": { "type": "string" }
      }
    },
    "successEvaluationPrompt": "Lead qualify oldu mu veya callback aldın mı?",
    "successEvaluationRubric": "PassFail"
  }
}
```

**Step 4: Workflow metadata**

Her arama başlatılırken metadata ekle:
```json
{
  "metadata": {
    "flow_type": "lead_qualification",
    "contact_id": "<uuid>"
  }
}
```

**Step 5: Test araması yap**

```bash
# VAPI API ile outbound call başlat
curl -X POST 'https://api.vapi.ai/call' \
  -H 'Authorization: Bearer <VAPI_API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "workflowId": "<workflow_id>",
    "customer": { "number": "+90<test_number>" },
    "phoneNumberId": "<vapi_phone_number_id>",
    "metadata": {
      "flow_type": "lead_qualification",
      "contact_id": "<test_contact_uuid>"
    }
  }'
# {"id":"<call_id>","status":"queued",...}
```

---

### Task 7: VAPI Workflow — Teklif Takibi

**Step 1: VAPI Dashboard → Workflows → Create Workflow**

İsim: `CRM Quote Follow-up`

**Step 2: Node yapısı**

```
Start Node:
  First Message: "Merhaba {{contact_name}}, #{quote_number} numaralı teklifiniz
    {{valid_until}} tarihinde sona eriyor. Bu konuda bir bilgi alabilir miyim?"
  Tools: [get_quote_details]

API Request Node → get_quote_details(quote_id)

Conversation Node (isim: "Karar Al"):
  Prompt: Müşterinin kararını al. Kabul, ret veya revizyon.
  Tools: [update_quote_status]
  dataExtractionPlan:
    decision: enum[accepted, rejected, revision_requested, callback]
    rejection_reason: string
    revision_notes: string

End Node "Kabul":
  Koşul: decision == 'accepted'
  Tool: update_quote_status(status='accepted')
  Message: "Harika! Teklifinizi onayladım, sözleşme sürecini başlatıyoruz."

End Node "Ret":
  Koşul: decision == 'rejected'
  Tool: update_quote_status(status='rejected', reason=rejection_reason)
  Message: "Anladım, geri bildiriminiz için teşekkürler."

End Node "Revizyon":
  Koşul: decision == 'revision_requested'
  Tool: update_quote_status(status='revision_requested')
  Message: "Notlarınızı aldım, ekibimiz güncellenmiş teklifi hazırlayacak."

Global Node "Yönetici Transfer":
  Enter condition: "Müşteri yöneticiyle görüşmek istiyor"
  → Transfer Call Node: satış yöneticisi numarası
```

---

### Task 8: VAPI Workflow — SLA Eskalasyonu

**Step 1: Yeni Workflow**

İsim: `CRM SLA Escalation`

**Step 2: Node yapısı**

```
Start Node (urgent ton):
  First Message: "Merhaba {{assignee_name}}, acil: #{ticket_number} nolu
    destek bileti SLA ihlalinde, {{hours_overdue}} saattir çözüm bekliyor."
  Tools: [get_ticket_details]
  Voice: Hızlı, net, profesyonel (acil ton)

API Request Node → get_ticket_details(ticket_id)

Conversation Node:
  Prompt: Sorumludan onay al. Üstlenme veya devretme.
  Tools: [update_ticket_escalation]
  dataExtractionPlan:
    action: enum[acknowledged, transfer, escalate_further]
    new_assignee_id: string

End Node "Onaylandı":
  Koşul: action == 'acknowledged'
  Tool: update_ticket_escalation(escalated=true)
  Message: "Teşekkürler, müşteriye hemen dönmenizi rica ederiz."

Transfer Node:
  Koşul: action == 'transfer'
  → Yedek sorumlu numarası

Global Node "Acil Eskalasyon":
  Enter condition: "Ulaşılamıyor veya çok kritik"
  → Transfer Call Node: +90xxx yönetim hattı
```

---

## FAZ 3: Orkestrasyon (n8n Scheduled Workflows)

### Task 9: n8n — Quote Takibi Scheduled Workflow

**Step 1: n8n → New Workflow → "Quote Follow-up Scheduler"**

```
Schedule Trigger:
  Cron: 0 9 * * 1-5  (Hafta içi 09:00)

Supabase Node (HTTP Request):
  GET: <SUPABASE_URL>/rest/v1/quotes
  Headers: apikey, Authorization: Bearer <SERVICE_ROLE_KEY>
  Query params:
    select: id,quote_number,valid_until,contact_id,contacts(first_name,last_name,phone)
    status: eq.pending
    valid_until: lte.<bugün+3gün>  (3 gün içinde sona erecek)

Split In Batches Node: batchSize=1

IF Node:
  Koşul: {{ $json.contacts?.phone }} !== null

VAPI Call Node (HTTP Request):
  POST: https://api.vapi.ai/call
  Headers: Authorization: Bearer <VAPI_API_KEY>
  Body:
    workflowId: <quote_followup_workflow_id>
    customer.number: {{ $json.contacts.phone }}
    phoneNumberId: <phone_number_id>
    metadata:
      flow_type: quote_followup
      quote_id: {{ $json.id }}
      contact_id: {{ $json.contact_id }}

Supabase Insert (crm_call_logs):
  status: initiated
  vapi_call_id: {{ $json.id }}  (VAPI response'dan)
  flow_type: quote_followup
  quote_id: {{ $json.quote_id }}
```

---

### Task 10: n8n — SLA Monitor Scheduled Workflow

**Step 1: n8n → New Workflow → "SLA Monitor"**

```
Schedule Trigger:
  Cron: */30 9-18 * * 1-5  (Hafta içi 09-18 arası her 30 dakika)

HTTP Request (Supabase):
  GET: <SUPABASE_URL>/rest/v1/v_ticket_sla
  Filtre: sla_status=eq.breached&vapi_called=is.null

IF Node: {{ $json.length > 0 }}

Split In Batches: batchSize=1

VAPI Call (HTTP Request):
  POST: https://api.vapi.ai/call
  Body:
    workflowId: <sla_escalation_workflow_id>
    customer.number: {{ $json.assignee_phone }}
    metadata:
      flow_type: sla_escalation
      ticket_id: {{ $json.ticket_id }}

Telegram Node (SLA Alert):
  🚨 *SLA İHLALİ*
  Bilet: #{{ $json.ticket_number }}
  Gecikme: {{ $json.hours_overdue }} saat
  Aranan: {{ $json.assignee_name }}
```

---

### Task 11: n8n — Lead Qualification Tetikleyici (Supabase Webhook)

**Step 1: Supabase → Database Webhooks → New Webhook**

```
Name: new-contact-vapi-trigger
Table: contacts
Events: INSERT
URL: https://<n8n_url>/webhook/new-contact-lead
Headers:
  x-webhook-secret: <secret>
```

**Step 2: n8n Workflow**

```
Webhook Node → (x-webhook-secret doğrula)

Code Node:
  // Çalışma saati kontrolü (09:00 - 18:00)
  const hour = new Date().getHours()
  const isWorkHour = hour >= 9 && hour < 18
  if (!isWorkHour) return []  // İş saati değilse atla
  return [$input.item]

IF Node: phone alanı dolu mu?

VAPI Call (HTTP Request):
  POST: https://api.vapi.ai/call
  Body:
    workflowId: <lead_qualification_workflow_id>
    customer.number: {{ $json.record.phone }}
    metadata:
      flow_type: lead_qualification
      contact_id: {{ $json.record.id }}

crm_call_logs INSERT: status=initiated
```

---

## FAZ 4: AtomicCRM UI

### Task 12: Supabase API — Arama Geçmişi Endpoint'i

**Step 1: PostgREST üzerinden direkt kullan**

AtomicCRM frontend'de Supabase client ile:

```typescript
// src/hooks/useCallLogs.ts
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

export function useCallLogs(params: {
  contactId?: string
  opportunityId?: string
  quoteId?: string
  ticketId?: string
}) {
  return useQuery({
    queryKey: ['call_logs', params],
    queryFn: async () => {
      let query = supabase
        .from('crm_call_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20)

      if (params.contactId) query = query.eq('contact_id', params.contactId)
      if (params.opportunityId) query = query.eq('opportunity_id', params.opportunityId)
      if (params.quoteId) query = query.eq('quote_id', params.quoteId)
      if (params.ticketId) query = query.eq('ticket_id', params.ticketId)

      const { data, error } = await query
      if (error) throw error
      return data
    }
  })
}
```

---

### Task 13: React — CallLogPanel Bileşeni

**Files:**
- Create: `src/components/calls/CallLogPanel.tsx`
- Create: `src/components/calls/AudioPlayer.tsx`
- Create: `src/components/calls/TranscriptModal.tsx`

**Step 1: AudioPlayer bileşeni**

```tsx
// src/components/calls/AudioPlayer.tsx
interface AudioPlayerProps {
  url: string
  durationSec?: number
}

export function AudioPlayer({ url, durationSec }: AudioPlayerProps) {
  return (
    <div className="flex items-center gap-2 bg-gray-50 rounded p-2">
      <audio
        controls
        src={url}
        className="w-full h-8"
        preload="metadata"
      />
      {durationSec && (
        <span className="text-xs text-gray-500 whitespace-nowrap">
          {Math.floor(durationSec / 60)}:{String(durationSec % 60).padStart(2, '0')}
        </span>
      )}
    </div>
  )
}
```

**Step 2: CallLogPanel bileşeni**

```tsx
// src/components/calls/CallLogPanel.tsx
import { useState } from 'react'
import { useCallLogs } from '../../hooks/useCallLogs'
import { AudioPlayer } from './AudioPlayer'
import { TranscriptModal } from './TranscriptModal'
import { supabase } from '../../lib/supabase'

const FLOW_LABELS: Record<string, string> = {
  lead_qualification: 'Lead Qualification',
  quote_followup: 'Teklif Takibi',
  sla_escalation: 'SLA Eskalasyon'
}

const SENTIMENT_EMOJI: Record<string, string> = {
  positive: '😊', neutral: '😐', negative: '😟'
}

interface Props {
  contactId?: string
  opportunityId?: string
  quoteId?: string
  ticketId?: string
  onNewCall?: () => void
}

export function CallLogPanel({ contactId, opportunityId, quoteId, ticketId, onNewCall }: Props) {
  const [selectedTranscript, setSelectedTranscript] = useState<string | null>(null)
  const { data: logs, isLoading } = useCallLogs({ contactId, opportunityId, quoteId, ticketId })

  async function handleNewCall() {
    // n8n webhook'u tetikle → VAPI outbound call başlat
    await fetch('/api/calls/initiate', {
      method: 'POST',
      body: JSON.stringify({ contactId, opportunityId, quoteId, ticketId })
    })
    onNewCall?.()
  }

  async function handleAddNote(log: typeof logs[0]) {
    // Transcript'i clipboard'a kopyala
    await navigator.clipboard.writeText(
      `[Arama Notu - ${new Date(log.called_at).toLocaleDateString('tr-TR')}]\n${log.summary}\n\nTranscript:\n${log.transcript}`
    )
    alert('Not panoya kopyalandı!')
  }

  async function handleTelegramShare(log: typeof logs[0]) {
    await fetch('/api/calls/telegram-share', {
      method: 'POST',
      body: JSON.stringify({ callLogId: log.id })
    })
    alert('Telegram\'a gönderildi!')
  }

  if (isLoading) return <div className="p-4 text-sm text-gray-500">Yükleniyor...</div>

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="bg-gray-50 px-4 py-3 flex items-center justify-between border-b">
        <h3 className="font-medium text-sm">📞 Arama Geçmişi ({logs?.length ?? 0})</h3>
        <button
          onClick={handleNewCall}
          className="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700"
        >
          + Yeni Arama
        </button>
      </div>

      {!logs?.length && (
        <div className="p-6 text-center text-sm text-gray-400">
          Henüz arama kaydı yok
        </div>
      )}

      <div className="divide-y">
        {logs?.map(log => (
          <div key={log.id} className="p-4 hover:bg-gray-50">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${log.success ? 'bg-green-500' : 'bg-red-400'}`} />
                <span className="text-sm font-medium">{FLOW_LABELS[log.flow_type]}</span>
                <span className="text-xs text-gray-400">
                  {new Date(log.called_at).toLocaleDateString('tr-TR')}
                </span>
              </div>
              <div className="flex items-center gap-1 text-xs text-gray-500">
                {log.duration_sec && (
                  <span>{Math.floor(log.duration_sec / 60)}:{String(log.duration_sec % 60).padStart(2, '0')}dk</span>
                )}
                {log.sentiment && <span>{SENTIMENT_EMOJI[log.sentiment]}</span>}
              </div>
            </div>

            {log.outcome && (
              <div className="text-xs text-gray-600 mb-2">Sonuç: <strong>{log.outcome}</strong></div>
            )}

            {log.recording_url && (
              <div className="mb-2">
                <AudioPlayer url={log.recording_url} durationSec={log.duration_sec ?? undefined} />
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {log.transcript && (
                <button
                  onClick={() => setSelectedTranscript(log.transcript)}
                  className="text-xs border rounded px-2 py-1 hover:bg-gray-100"
                >
                  📄 Transcript
                </button>
              )}
              {log.summary && (
                <button
                  title={log.summary}
                  className="text-xs border rounded px-2 py-1 hover:bg-gray-100"
                >
                  📋 Özet
                </button>
              )}
              <button
                onClick={() => handleAddNote(log)}
                className="text-xs border rounded px-2 py-1 hover:bg-gray-100"
              >
                ✏️ Nota Ekle
              </button>
              <button
                onClick={() => handleTelegramShare(log)}
                className="text-xs border rounded px-2 py-1 hover:bg-gray-100"
              >
                📤 Telegram
              </button>
            </div>
          </div>
        ))}
      </div>

      {selectedTranscript && (
        <TranscriptModal
          transcript={selectedTranscript}
          onClose={() => setSelectedTranscript(null)}
        />
      )}
    </div>
  )
}
```

**Step 3: Detay sayfalarına ekle**

```tsx
// Contact, Opportunity, Quote, Ticket detay sayfalarına ekle:
import { CallLogPanel } from '../components/calls/CallLogPanel'

// Contact sayfasında:
<CallLogPanel contactId={contact.id} />

// Opportunity sayfasında:
<CallLogPanel opportunityId={opportunity.id} />

// Quote sayfasında:
<CallLogPanel quoteId={quote.id} />

// Ticket sayfasında:
<CallLogPanel ticketId={ticket.id} />
```

**Step 4: Commit**

```bash
git add src/components/calls/ src/hooks/useCallLogs.ts
git commit -m "feat(ui): add CallLogPanel with audio player and action buttons"
```

---

## FAZ 5: Analytics

### Task 14: Metabase — Arama Analitikleri View

**Step 1: Migration ekle**

```sql
-- supabase/migrations/20260219000003_call_analytics_view.sql

CREATE VIEW v_call_analytics AS
SELECT
  flow_type,
  DATE_TRUNC('day', called_at)::date AS call_date,
  COUNT(*)                                           AS total_calls,
  COUNT(*) FILTER (WHERE status = 'completed')       AS completed,
  COUNT(*) FILTER (WHERE status = 'no_answer')       AS no_answer,
  COUNT(*) FILTER (WHERE success = true)             AS successful,
  ROUND(AVG(duration_sec))                           AS avg_duration_sec,
  COUNT(*) FILTER (WHERE sentiment = 'positive')     AS positive,
  COUNT(*) FILTER (WHERE sentiment = 'neutral')      AS neutral,
  COUNT(*) FILTER (WHERE sentiment = 'negative')     AS negative
FROM crm_call_logs
WHERE called_at IS NOT NULL
GROUP BY flow_type, DATE_TRUNC('day', called_at)
ORDER BY call_date DESC, flow_type;
```

**Step 2: Metabase'e ekle**

```bash
# Metabase → Browse Data → sync tetikle
# Metabase API ile:
curl -X POST 'http://<metabase_url>/api/database/3/sync_schema' \
  -H 'x-metabase-session: <session_token>'
```

**Step 3: Yeni dashboard kartları oluştur**

- Toplam Arama Sayısı (scalar)
- Başarı Oranı % (scalar)
- Akışa Göre Arama Dağılımı (pie chart)
- Günlük Arama Trendi (line chart)
- Duygu Dağılımı (bar chart)

---

### Task 15: Telegram — Günlük Özet Workflow

**n8n → New Workflow → "Daily Call Summary"**

```
Schedule Trigger: 0 18 * * 1-5  (Her iş günü 18:00)

HTTP Request (Supabase):
  GET: /rest/v1/v_call_analytics
  Filtre: call_date=eq.{{ new Date().toISOString().split('T')[0] }}

Code Node:
  const rows = $input.all().map(i => i.json)
  const total = rows.reduce((s, r) => s + r.total_calls, 0)
  const success = rows.reduce((s, r) => s + r.successful, 0)
  const rate = total > 0 ? Math.round(success / total * 100) : 0

  const lines = rows.map(r =>
    `  ${r.flow_type}: ${r.total_calls} arama → ${r.successful} başarılı`
  ).join('\n')

  return [{ json: { total, success, rate, lines } }]

Telegram Node:
  📊 *Günlük Arama Özeti*
  📅 {{ new Date().toLocaleDateString('tr-TR') }}

  Toplam: {{ $json.total }} arama
  Başarılı: {{ $json.success }} (%{{ $json.rate }})

  {{ $json.lines }}
```

---

## Özet: Execution Sırası

```
Faz 1 (Altyapı):     Task 1 → 2 → 3 → 4
Faz 2 (Dialog):      Task 5 → 6 → 7 → 8
Faz 3 (Otomasyon):   Task 9 → 10 → 11
Faz 4 (UI):          Task 12 → 13
Faz 5 (Analytics):   Task 14 → 15
```

**Demo için minimum set:** Task 1 + 2 + 3 + 4 + 5 + 6 (Lead Qualification tek akışı) + Task 12 + 13

---

## Environment Variables Listesi

```bash
# Supabase
SUPABASE_URL=https://...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

# VAPI
VAPI_API_KEY=...
VAPI_WEBHOOK_SECRET=...
VAPI_PHONE_NUMBER_ID=...
VAPI_WORKFLOW_LEAD=...
VAPI_WORKFLOW_QUOTE=...
VAPI_WORKFLOW_SLA=...

# Telegram
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CRM_CHAT_ID=...

# n8n
N8N_WEBHOOK_SECRET=...
```
