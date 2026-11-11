# Grant readiness: Nexus A2A

Hedef program: Circle Developer Grants (circle.com/grant). Bilgiler o sayfadan ve Arc House
duyurusundan alindi. Basvuru oncesi sayfayi tekrar kontrol et, kosullar degisebilir.

## Programin istedikleri ve bizim durumumuz

| Kriter | Programin dedigi | Bizde durum | Not |
|---|---|---|---|
| Platform uyumu | Arc akis/likidite/settlement icin cekirdek, Circle urunleri anlamli parca | Iyi | Arc mainnet, USDC, ERC-8004, CCTP V2, Modular Wallets (passkey). Gateway ve Developer-Controlled Wallets henuz yok |
| Ekip | Kanitlanmis teslimat, net teknik sahiplik | Eksik | Basvuruda ekip, gecmis isler ve GitHub gecmisi acik yazilmali |
| Traction | Kullanim, pilot, ortaklik, gelir veya inandirici yol | Zayif | Mainnet'te 3 is var ve hepsi bizim testimiz. Dis kullanici yok |
| Ekosistem etkisi | USDC kullanimini artirir, baskalarina altyapi olur | Iyi potansiyel | Agentic economic activity programin ilk odak alani. SDK ve ornek ajan yok |

## Kritik eksikler (basvurudan once)

1. **Arayuzde simule edilmis ajanlar var.** Tahtadaki bes ajan (PriceOracleBot vb.) kodda sabit
   yazili, bakiyeleri ve itibarlari uydurma. Gercek is verisinin yaninda gosteriliyor. Degerlendirici
   bunu gercek sanabilir. Ya acikca "SIMULATION" diye etiketlenmeli ya da gercek ERC-8004 ajanlari
   ve zincirdeki islerle degistirilmeli.
2. **v2 mainnet'te degil.** Canli olan v1: pull odeme, timelock, itiraz penceresi yok ve CCTP
   funder'i calismiyor. Basvuruda "canli" denen sey v1 olmamali.
3. **Bagimsiz denetim yok.** Para tutan kontrat icin degerlendiriciler bunu sorar. En azindan bir
   denetim firmasindan teklif/tarih alinmali ve ilk milestone'a konmali.
4. **Dis kullanici/traction yok.** En az birkac gercek ajan ve gercek is gerekli.
5. **Calisan, herkese acik demo yok.** Barindirilmis bir URL ve 3 dakikalik video lazim.
6. **Ekip bilgisi ve milestone butcesi yok.**

## Yapilanlar (bu tur)

- README v2'ye gore yeniden yazildi (eski README yanlis CCTP talimati iceriyordu).
- LICENSE (MIT), SECURITY.md, `docs/security.md` eklendi.
- CI eklendi (`.github/workflows/ci.yml`): forge build/test ve frontend typecheck. Henuz calistirilmadi.
- `contracts/lib` git'te yoktu, temiz klonda derlenmiyordu. `contracts/install-deps.sh` ile sabit
  surumler indiriliyor.
- `frontend/dist` (92 dosya) repodan cikarildi, `.env.example` eklendi.
- Mainnet RPC adresi duzeltildi.

## Plan (sirayla)

### Faz 0: Hemen (bu hafta)
- [ ] Arayuzdeki simule ajanlari kaldir veya etiketle (ben yaparim).
- [ ] Passkey cuzdanin calistigini dogrula (Circle Console domain ayari, sen).
- [ ] Explorer'da kontrat kaynaklarini dogrula (sen). README "verified" demiyor, dogruysa ekle.
- [ ] GitHub Security sekmesinde "Report a vulnerability"i ac (sen).
- [ ] LICENSE'taki telif sahibi adini gercek adinla degistir (sen).

### Faz 1: Basvuru oncesi
- [ ] v2'yi Arc Testnet'te dene, sonra mainnet'e deploy et (sen, `docs/deploy-checklist.md`).
- [ ] Referans ajan paketi: istemci, saglayici ve degerlendirici ajan Circle Developer-Controlled
      Wallets ile tum yasam dongusunu calistirir (ben yaparim). Bu hem Circle entegrasyonu hem demo olur.
- [ ] CCTP V2'yi testnet'te gercek kontratlarla dene.
- [ ] Gercek islerle traction: kendi ajanlarinla en az 20-30 is, 3-5 dis gelistirici davet et.
- [ ] Barindirilmis demo URL'si ve 3 dakikalik video.
- [ ] Denetim firmasindan teklif/tarih al.

### Faz 2: Milestone onerisi (programla birlikte netlestirilir)
| Milestone | Teslim | Olculebilir sonuc |
|---|---|---|
| M1 | Bagimsiz denetim, bulgularin kapatilmasi, v2 mainnet | Denetim raporu yayinda, v2 canli |
| M2 | TypeScript SDK ve 3 referans ajan, CCTP ile cok zincirli finansman | Mainnet'te gercek isler, dis entegrator sayisi |
| M3 | Arbiter icin VRF veya komite, evaluator kayit defteri, indexer ve panel | Is sayisi, USDC hacmi, benzersiz ajan |
| M4 | Gateway ile birlesik bakiye, ekosistem entegrasyonlari | Entegre eden proje sayisi |

Rakamlari (is sayisi, hacim) gercekci ve dogrulanabilir yaz. Grant miktarini programin portali belirler.

## Basvuru metni iskeleti (Ingilizce)

- **One line:** Escrow, bond and reputation infrastructure for AI agents that hire each other on Arc, settled in USDC.
- **Problem:** Agents cannot trust each other to deliver before paying. Without escrow and independent checking, agent commerce does not scale.
- **Solution:** ERC-8183 jobs with an independent evaluator, provider bonds, ERC-8004 reputation, pull payouts, optional dispute window.
- **Why Arc:** USDC native gas, predictable fees, sub-second finality, ERC-8004 registries on Arc.
- **Circle products:** USDC, CCTP V2 (cross-chain funding), Modular Wallets (passkey), planned: Developer-Controlled Wallets, Gateway.
- **Shipped:** v1 contracts on Arc Mainnet, v2 with 136 tests, deploy tooling, frontend.
- **Traction:** fill in with real numbers only.
- **Team:** fill in.
- **Revenue path:** platform fee (default 2%) on completed jobs.
- **Risks, stated openly:** no independent audit yet, arbiter selection is not random, CCTP V2 not yet run on live contracts.
- **Milestones:** table above.
- **Links:** repo, demo, video, forum thread, explorer addresses.

## Microgrants

Arc Microgrants (500 USDC) kapanis tarihi 14 Ekim 2026 idi, bugun gecmis. Programin sayfasi
tarihlerin degisebilecegini soyluyor. Yeniden acilirsa v1 mainnet'te canli ve repo acik oldugu icin
uygun olabilir.
