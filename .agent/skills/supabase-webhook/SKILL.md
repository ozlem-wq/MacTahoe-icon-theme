# Supabase Webhook Skill

Supabase webhooks ve n8n entegrasyonu yönetimi.

## Komutlar

### `create`
Yeni bir webhook subscription oluşturur.

```bash
/supabase-webhook create
```

Sorulacak bilgiler:
- Tablo adı (örn: `users`, `orders`)
- Event tipi (`INSERT`, `UPDATE`, `DELETE`, `*`)
- Webhook URL
- Secret key (opsiyonel)

### `list`
Tüm aktif webhook subscription'larını listeler.

```bash
/supabase-webhook list
```

### `test <id>`
Belirtilen webhook endpoint'ini test eder.

```bash
/supabase-webhook test abc123
```

### `logs <id>`
Webhook delivery loglarını görüntüler.

```bash
/supabase-webhook logs abc123
```

### `n8n <event>`
Belirtilen event için n8n workflow şablonu oluşturur.

```bash
/supabase-webhook n8n user.created
/supabase-webhook n8n order.updated
/supabase-webhook n8n payment.completed
```

Desteklenen event'ler:
- `user.created` - Yeni kullanıcı kaydı
- `user.updated` - Kullanıcı güncellemesi
- `order.created` - Yeni sipariş
- `order.updated` - Sipariş güncellemesi
- `payment.completed` - Ödeme tamamlandı
- `custom.<table>.<event>` - Özel event

### `migrate`
Webhook sistemi için SQL migration dosyaları oluşturur.

```bash
/supabase-webhook migrate
```

Oluşturulan dosyalar:
- `supabase/migrations/xxx_webhook_subscriptions.sql`
- `supabase/migrations/xxx_webhook_logs.sql`
- `supabase/migrations/xxx_webhook_functions.sql`

### `deploy`
Edge function'ları Supabase'e deploy eder.

```bash
/supabase-webhook deploy
```

### `status`
Webhook sisteminin durumunu kontrol eder.

```bash
/supabase-webhook status
```

## Konfigürasyon

Proje kök dizininde `.env` dosyasında:

```env
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
N8N_WEBHOOK_URL=https://your-n8n-instance.com/webhook
```

## Örnek Kullanım

### 1. Yeni kullanıcı için n8n workflow oluşturma

```bash
/supabase-webhook n8n user.created
```

Bu komut şunları oluşturur:
- n8n workflow JSON dosyası
- Supabase trigger SQL'i
- Edge function kodu

### 2. Webhook test etme

```bash
/supabase-webhook create
# Tablo: users
# Event: INSERT
# URL: https://n8n.example.com/webhook/abc123

/supabase-webhook test <subscription-id>
```

## Dosya Yapısı

```
supabase/
├── functions/
│   └── webhook-handler/
│       └── index.ts
├── migrations/
│   ├── 001_webhook_subscriptions.sql
│   ├── 002_webhook_logs.sql
│   └── 003_webhook_triggers.sql
└── n8n-workflows/
    └── user-created.json
```
