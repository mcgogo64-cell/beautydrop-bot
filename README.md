# BeautyDrop Bot (GitHub Actions Hazır)

Bu repo, verdiğiniz **ülkere göre kategorize edilmiş mağaza URL'lerinden** (bkz. `feeds/beautydrop-feeds.txt`) verileri **sunucusuz** olarak toplar ve çıktıyı her gün otomatik olarak `data/deals-latest.json` dosyasına kaydeder.

## Nasıl Çalışır?
- Bot (`bot.mjs`) Playwright ile listedeki sayfaları açar, ürün başlık/bağlantı/fiyat gibi temel bilgileri toplar.
- RSS ise `fast-xml-parser` ile daha hızlı işlenir.
- Erkek ürünleri çok dilli regex ile **otomatik dışlanır**.
- GitHub Actions, **her gece 03:00 (UTC)** çalışır ve `data/` klasöründeki JSON dosyasını _commit + push_ eder.
- Uygulamanız bu dosyayı doğrudan şuradan okuyabilir (repo adınızı/kullanıcınızı değiştirin):
  ```
  https://raw.githubusercontent.com/<kullanici-adiniz>/<repo-adiniz>/main/data/deals-latest.json
  ```

## Hızlı Kurulum
1. Bu `.zip` içeriğini **yeni bir GitHub reposuna** yükleyin.
2. GitHub → **Actions** sekmesinde workflow'un aktif olduğundan emin olun.
3. İlk çalıştırma için **Run workflow** butonuna basabilirsiniz veya cron'u bekleyin.
4. Manuel çalıştırma (lokalde):
   ```bash
   npm ci
   npm run playwright:install
   npm run daily
   ```

## Yapı
```
beautydrop-bot/
├─ bot.mjs
├─ package.json
├─ LICENSE
├─ README.md
├─ feeds/
│  └─ beautydrop-feeds.txt
├─ data/
│  └─ .gitkeep
└─ .github/
   └─ workflows/
      └─ daily.yml
```

## Notlar
- Playwright, CI'da gerekli tarayıcı bağımlılıklarını otomatik kurar (`--with-deps`).
- Eğer bazı sitelerde kart seçimi değişirse `OVERRIDES` tablosuna bir satır eklemeniz yeterli.
- Cron saatini `daily.yml` içinde değiştirebilirsiniz.
