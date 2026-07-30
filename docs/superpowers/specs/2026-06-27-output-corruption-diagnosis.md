# Kimeneti korrupció — diagnózis és javítási terv

**Dátum:** 2026-06-27
**Forrás:** a `Significance Series Boxset` job (`75e7d9e4-…`) valós kimenete, mind a 24 fejezet
letöltve a deployról (`/api/result`) és átvizsgálva.
**Státusz:** IMPLEMENTÁLVA + ellenőrizve (2026-06-27). 82 teszt zöld, typecheck tiszta, élő
DeepSeek e2e: 0 maradék sentinel, 11/11 tag megőrizve, magyar kimenet. Még nincs commitolva /
deployolva. Új funkció is bekerült: „csak az első 5%" próbafordítás-mód.

---

## 1. Tünetek (a felhasználó jelzése alapján)

1. A fordítás olvasva jó, de a **tagolás/markup teljesen rossz**.
2. A **tagek bekerülnek a szövegbe**, az eredeti formátum elveszik.
3. A **hyperlinkek nem működnek**.
4. Néha **több oldalnyi, szóköz nélküli angol szöveg** kerül a könyvbe.
5. Az **encoding is rossznak tűnik**.
6. **Hibák kerültek be**, amiket „oldalakra rakott".

## 2. Megerősített gyökérokok (valós kimenettel bizonyítva)

### A) A láthatatlan PUA-sentinel séma szétesik → tagek/linkek elvesznek
- A belső tageket (`<em>`, `<a href>`, …) láthatatlan Private-Use-Area karakterekre
  cseréljük: `␀N␁` = `U+E000` + index + `U+E001` (lásd `lib/core/markup.ts`).
- A modell a *láthatatlan* határoló-karaktereket nem őrzi meg megbízhatóan: gyakran az
  egyik PUA-határolót ledobja, de a számot bent hagyja.
- Következmény:
  - `restore()` regexe (`␀\s*(\d+)\s*␁`) nem talál egyezést → **a tag/link soha nem
    kerül vissza** (hyperlink + formátum elvész),
  - a szövegben **csupasz szám + szemét PUA-karakter** marad
    (pl. `…csinálhatunk valamit."1</span>`, `…megtörtént. 1</p>`).
- Mérés: fejezetenként 40–280 leakelt PUA-karakter a kész könyvben (2–15. fejezet).

### B) `temperature: 1.3` → degenerált tokensaláta („oldalnyi szóköz nélküli angol")
- `lib/core/providers/deepseek.ts`: `TEMPERATURE = 1.3`. Túl forró megbízható,
  marker-megőrző kimenethez.
- Valós példák:
  - 3. fej.: `"Space in he our Some old was moments many night'd bed It yet fl So Up She lay happen bed…"`
  - 13. fej.: `"A final went try . The Hell .. Do'. of The far The of as Even her A!…"`
- Ez pontosan a 4. tünet.

### C) Nincs blokkoló kimeneti guard → a modell hibái beégnek a könyvbe
- 2. fej. — **megtagadás fordításként**:
  `"Sorry, I can't generate a translation for a passage that includes tokens with
  legal/dedication/copyright boilerplate…"`
- 4. és 9. fej. — **a modell gondolatmenete beégetve**, a 9.-ben **kínaiul** a
  token-megőrzési szabályokról elmélkedve:
  `"**注意**：如果这是单个句子… 按您之前的说明 Keep EVERY token and marker…"`
- A `validators.ts` *érzékeli* a token-eltérést, de a `route.ts::routeDraft` ezt csak a
  finomító-passra használja, ami `MAX_QUALITY_ITERATIONS = 2` után **mindig `accept`**.
  Nincs „dobd el / fordítsd újra temp 0-n / jelöld hibásnak" ág. Ráadásul a validátorok
  csak `selectiveRefine` esetén futnak egyáltalán.

### D) „Encoding" — NINCS valódi charset-hiba
- Az ékezetek (á é í ó ö ő ú ü ű) minden fejezetben épek, a kimenet valódi UTF-8.
- Amit a felhasználó encoding-hibának látott, az a B/A pontból eredő PUA-szemét és a
  csupasz számok. Az encoding réteg rendben van.

## 3. A javítás iránya (jóváhagyott alapelvek)

1. **Temperature le** 1.3 → ~0.4–0.6. Egyedül ez kiirtja a tokensaláta nagy részét.
2. **Valódi kimeneti guard**, ami képes egy chunkot elbuktatni:
   - megtagadás-detektálás (regex: „Sorry, I can't", „I cannot translate", „as an AI"…),
   - rossz-nyelv detektálás (magyar kimenetben CJK vagy túlnyomó angol → elutasítás),
   - token/marker-épség **blokkoló** ellenőrzése,
   - sikertelen chunk → újrafordítás temp 0-n, majd ha úgy se → a meglévő per-chunk
     failure-izoláció (commit `a6d36f3`) jelölje hibásnak (ne égessen be szemetet).
3. **A PUA-séma lecserélése** robusztusabbra — **döntés előtt valós A/B kísérlet** (lásd 4.).

## 4. Tervezett A/B kísérlet (jóváhagyás + API-kulcs után, fizetős!)

**Cél:** adatvezérelt döntés a markup-séma cseréjéről a nagy átírás előtt.

**Mit hasonlítunk:**
- (jelenlegi) láthatatlan PUA `␀N␁`,
- (jelölt 1) **valódi HTML tagek megtartása** + „őrizd a tageket" utasítás,
- (jelölt 2) **látható sentinel** (`⟦0⟧` / `【0】`).

**Hogyan:**
- ~6–10 valós, nehéz chunk a meglévő könyvből (sok inline tag, `<a href>`, dialógus).
- Mindegyik sémát ugyanazon chunkokon, `temperature` 0.5-ön és 1.3-on is.
- Mérőszámok chunkonként: tag-multiset round-trip egyezés, leakelt sentinel-karakterek
  száma, megtagadás/idegen-nyelv előfordulás, hossz-arány, szubjektív olvashatóság.

**Költség/biztonság:** valós DeepSeek hívások → pénz. Csak külön jóváhagyással,
a felhasználó API-kulcsával futtatjuk. Egyszeri kísérlet, nem a fő pipeline.

## 4b. A/B KÍSÉRLET EREDMÉNYE (2026-06-27, valós DeepSeek deepseek-v4-flash)

Lefutott három kísérlet a felhasználó test-kulcsával, valós forrásblokkokon a könyvből.

**Egyblokkos teszt (raw bizonyíték):** a PUA séma a modell kimenetében így nézett ki:
`"...Ő ott ült. Csak1\n2ott ült34, nem fotózott..."` — a modell **letörölte a láthatatlan
PUA-határolókat, és csak a csupasz számokat hagyta bent**. Ez pontosan a produkciós tünet
(`."1</span>`, `megtörtént. 1`). A SENT (`⟦N⟧`) és a HTML séma ugyanezen blokkon tökéletesen
megőrizte a tageket (a `<a href="#chapter1">` byte-pontosan túlélt).

**Stressz/ismétléses tanulmány — 4 nehéz prózablokk × 8 ismétlés @ temp 1.3 (n=32/séma):**

| Séma | Tiszta | Tag-vesztő futás | Maradék szemét-karakter | Hibamód |
|------|--------|------------------|--------------------------|---------|
| PUA (jelenlegi) | 20/32 (63%) | 12 | **13** | piszkos — tagvesztés + csupasz számok a szövegben |
| SENT (`⟦N⟧`) | **30/32 (94%)** | 2 | **0** | tiszta — blokk elveszti a formázást, de nincs látható szemét |
| HTML (valódi tag) | 28/32 (88%) | 4 | 0 | tiszta — de néha egy blokk összes tagjét eldobja |

Tanulság: a PUA **a futások 37%-án hibázik temp 1.3-on, ráadásul szemetet hagy** — egy 352
chunkos könyvön (finomító-passokkal) ez garantálja az átfogó korrupciót. A SENT és a HTML
hibái „tiszták" (csak hiányzó formázás, nincs látható szemét) ÉS detektálhatók (tag-szám
eltérés → a guard újrafordíthatja).

## 4c. DÖNTÉS: SENT — látható sentinel tokenek (`⟦N⟧` inline, `【N】` blokk)

Indok (adatvezérelt):
- legmagasabb tiszta arány (94% még temp 1.3-on is),
- **soha nincs maradék szemét** → a „csupasz szám/`."1`" tünet teljesen megszűnik,
- a legkisebb kódváltozás: a meglévő `protect`/`restore` architektúra marad, csak a
  láthatatlan PUA-karaktereket cseréljük látható, ritka Unicode-zárójelekre,
- a hibák tiszták és detektálhatók, így a guard elkapja és újrafordítja a ~6%-ot.
- A `⟦⟧` (U+27E6/7) és `【】` (U+3010/1) prózában gyakorlatilag soha nem fordulnak elő, így
  nem ütköznek valódi szöveggel.

A HTML elvetve: invazívabb (a tokenizáció eltávolítása, attribútum/href round-trip
ellenőrzés), egyszer üres kimenetet adott, és néha egy egész blokk tagjeit eldobja.

## 5. Sorrend a döntés után

1. A/B eredmény → markup-séma kiválasztása.
2. TDD: új markup + guard + temperature, a meglévő tesztkészletre építve
   (`markup.test.ts`, `validators.test.ts`, `translator.test.ts`, `job-failure-isolation.test.ts`).
3. Egy próbafordítás a szerveren, ugyanazon könyv egy fejezetén, ellenőrzés a
   `/api/result` kimeneten (PUA-leak = 0, nincs idegen nyelv, tagek round-trippelnek).

## Érintett fájlok

- `lib/core/markup.ts` — sentinel séma
- `lib/core/providers/deepseek.ts` — temperature, prompt, guard
- `lib/core/quality/validators.ts` + `route.ts` — blokkoló guard
- `lib/core/translator.ts` — retry/fallback ág
- `lib/core/job.ts` — per-chunk failure-izoláció (már megvan)
