# AtomicCRM - Metabase Deployment Raporu

## Genel Bakis
AtomicCRM projesinin raporlama modulu icin Metabase, Coolify uzerinde deploy edildi.
Metabase, Supabase PostgreSQL veritabanina baglanarak satis, fatura, destek ve kampanya raporlari sunacak.

## Ortam Bilgileri
- **Coolify API**: `http://<COOLIFY_IP>:8000/api/v1`
- **Coolify Versiyonu**: v4.0.0-beta.442
- **Metabase URL**: `http://metabase-<SERVICE_UUID>.<COOLIFY_IP>.sslip.io`
- **Metabase Versiyonu**: v0.58.5.5
- **Supabase PG**: Ayni sunucuda (cx33), Docker internal network ile bagli

## Onemli UUID / ID'ler
> Not: Gercek UUID degerler icin yerel `.env` veya Coolify Dashboard'a bakin.

| Kaynak | Aciklama |
|--------|----------|
| Metabase Service | Coolify Services sayfasindan alinabilir |
| Supabase Service | Coolify Services sayfasindan alinabilir |
| cx33 Server | Coolify Servers sayfasindan alinabilir |
| Metabase DB ID (Supabase) | `2` |

## Metabase Admin Giris
- **E-posta**: Coolify ortam degiskenlerinden veya yerel notlardan alin
- **Sifre**: Coolify ortam degiskenlerinden veya yerel notlardan alin

> ⚠ Credential'lar bu dosyada saklanmaz. Yerel ortamda guvenli bir yerde tutun.

## Supabase PG Baglanti Bilgileri
- **Host**: Supabase DB container adi (Coolify servisi icinden gorulebilir)
- **Port**: `5432`
- **Database**: `postgres`
- **User**: `postgres`
- **Password**: Coolify Supabase service env'lerinden alin

## Metabase Mimarisi
- Metabase kendi metadata'si icin **ayri bir PostgreSQL** (postgres:16-alpine) kullanacak
- CRM veritabanina (Supabase PG) **database connection** olarak baglanmis (DB ID: 2)
- Docker Compose ile 2 servis: `metabase` + `postgresql` (metadata)
- Her iki servis de **cx33 sunucusunda** (Server ID: 1) calisiyor
- `connect_to_docker_network: true` sayesinde Supabase PG'ye internal erisiyor

## Mevcut Dashboard View'lari (Sync Tamamlandi)
| View | Metabase Table ID | Aciklama |
|------|-------------------|----------|
| `v_dashboard_sales_kpis` | 21 | Satis KPI kartlari |
| `v_dashboard_quotes` | 11 | Teklif istatistikleri |
| `v_dashboard_invoices` | 12 | Fatura istatistikleri |
| `v_ticket_sla` | 76 | SLA takip tablosu |
| `v_overdue_tasks` | 41 | Geciken gorevler |
| `v_upcoming_tasks` | 94 | Yaklasan gorevler |

**Toplam**: 95 tablo/view sync edildi (42 public tablo + 6 view + geri kalan diger schemalar)

---

## Ilerleme Durumu

### Adim 1: Coolify API Token Dogrulama ✅
- **Durum**: TAMAMLANDI
- Coolify API v4 dogrulandi

### Adim 2: Coolify Kaynaklarini Kesfet ✅
- **Durum**: TAMAMLANDI
- **Sunucular**: localhost (server 0, Coolify host), cx33 (server 1)
- **Projeler**: "My first project", "n8n"
- **Servisler**: n8n, pgbackweb, pgadmin, supabase, teable, metabase-crm

### Adim 3: Supabase PostgreSQL Baglanti Bilgileri ✅
- **Durum**: TAMAMLANDI

### Adim 4: Metabase Deploy ✅
- **Durum**: TAMAMLANDI
- **Onemli Not**: Ilk deneme localhost (server 0)'da yapildi, network erisimi olmadigi icin cx33'e (server 1) tasinarak cozuldu
- Status: `running:healthy`

### Adim 5: Domain / Proxy Yapilandirmasi ✅
- **Durum**: TAMAMLANDI
- Traefik proxy aktif, sslip.io ile otomatik DNS

### Adim 6: Metabase Supabase PG Baglantisi ✅
- **Durum**: TAMAMLANDI
- Metabase API ile `POST /api/database` kullanilarak eklendi
- Sync tamamlandi: 95 tablo/view
- 6 dashboard view kesfedildi

### Adim 7: Dashboard Olusturma ✅
- **Durum**: TAMAMLANDI
- **Collection**: AtomicCRM (ID: 5)
- **Dashboard**: AtomicCRM Dashboard (ID: 2)
- **Toplam Kart**: 22 (6 baslik + 13 KPI scalar + 3 tablo)
- **Olusturulan Sorgular**:
  - Satis KPI: Acik Firsatlar (38), Pipeline Degeri (39), Aylik Kazanimlar (40), Aylik Gelir (41)
  - Teklif KPI: Bekleyen Teklifler (42), Bekleyen Teklif Degeri (43), Aylik Kabul Edilen (44), Suresi Gecen (45)
  - Fatura KPI: Bekleyen Faturalar (46), Bekleyen Degeri (47), Geciken Faturalar (48), Geciken Degeri (49), Aylik Tahsilat (50)
  - Tablolar: SLA Takip (51), Geciken Gorevler (52), Yaklasan Gorevler (53)
- **Veri Dogrulamasi**:
  - Acik Firsatlar: 10
  - Geciken Gorevler: 9 adet
  - SLA Kayitlari: 1 adet

### Adim 8: Dogrulama ✅
- [x] Metabase login sayfasi erisilebilir
- [x] Metabase'e giris yapildi
- [x] Supabase veritabani baglanmis ve sync tamamlanmis
- [x] Dashboard olusturulmus ve veri gosteriyor (22 kart, canli veri)

---

## Karsilasilan Sorunlar ve Cozumler

### 1. Network Erisim Sorunu
- **Sorun**: Metabase (server 0/localhost) Supabase PG'ye (server 1/cx33) erisemediydi
- **Sebep**: Coolify farkli "server"lardaki servisleri farkli Docker network'lere koyuyor
- **Denenen**: docker-compose'a external network eklemek → Coolify override etti
- **Cozum**: Metabase'i Supabase ile ayni sunucuya (cx33) deploy edip `connect_to_docker_network: true` etkinlestirildi

### 2. Metabase Admin Sifre Sorunu
- **Sorun**: Ilk kurulumda admin sifresi eslesmedi
- **Cozum**: Metabase servisi silindi, sifirdan olusturuldu, setup API ile temiz kurulum yapildi

### 3. Setup API'de Database Eklenmemesi
- **Sorun**: `POST /api/setup` ile database eklense de, listeye dusmedi
- **Cozum**: Setup tamamlandiktan sonra `POST /api/database` ile manuel ekleme yapildi

---

## Tarih
- **Baslangic**: 2026-02-11
- **Son Guncelleme**: 2026-02-11
- **Durum**: TUM ADIMLAR TAMAMLANDI ✅
