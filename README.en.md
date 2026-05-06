# VocabRadar

[中文](./README.md) · [**English**](./README.en.md)

> Build vocabulary as you read. No flashcards.

A Chrome extension that turns passive reading into active vocabulary growth. Look up any English word on any web page, and DeepSeek gives you a context-aware translation. Words you don't know get auto-saved into a personal state machine — next time you visit a page that contains them, they're **automatically highlighted**, so review happens naturally.

**100% local storage. No backend. No server. No privacy concerns.**

<!-- ![demo](docs/demo.gif) -->

---

## How is this different from other "click-to-translate" tools?

Click-to-translate is a tool. VocabRadar is a **vocabulary growth system**.

| Other tools | VocabRadar |
|---|---|
| Look up, then forget | Auto-saved; auto-highlighted next time you read it |
| Dictionary lookup, no context | DeepSeek reads the full sentence and gives you "what it means *here*" |
| You look up the same word repeatedly with no signal | Words looked up ≥ 3 times turn deeper orange — your "stuck word" radar |
| Your data goes to a third party | **Everything stays in your browser.** Uninstall = data gone. |
| Subscription / freemium | BYOK: bring your own DeepSeek key. ~¥1-3/month for heavy use. |

---

## Screenshots

> _Screenshots placeholder; demo gif coming._

---

## Install

> ⚠️ Not yet on the Chrome Web Store. Manual unpacked install for now.

**Step 1: Get the code**

```bash
git clone https://github.com/russodope/vocab-radar.git
```

Or download the ZIP from GitHub.

**Step 2: Load it into Chrome**

1. Open `chrome://extensions/`
2. Toggle on "Developer mode" (top-right)
3. Click "Load unpacked"
4. Select the `vocab-radar/extension/` folder

**Step 3: Get a DeepSeek API key**

1. Visit [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)
2. Create a new key (name it `VocabRadar` for easier tracking)
3. **Recommended:** set a monthly spending limit (e.g. ¥10/month — heavy use rarely exceeds ¥1-3)

**Step 4: Paste the key**

A welcome page opens automatically on first install. Paste your key, click "Save & test" → ✓ done.

You can change the key (and language pair) any time from the toolbar VocabRadar icon → popup → settings.

---

## How to use

| Action | Behavior |
|---|---|
| **Double-click** an English word | Lookup popup → DeepSeek streams a definition + example |
| **Drag-select** a phrase (e.g. `no-brainer`) | Same as above |
| Click "Got it" in popup | Marked as `familiar` — no longer highlighted |
| Click "Mastered" in popup | Marked as `graduated` — never highlighted again |
| Click "Skip" in popup | Removed from vocab entirely (use this for accidental triggers) |
| Hover a highlighted word | Brief tooltip with the cached definition (300 ms delay) |
| Click the toolbar icon | See stats + change settings |

### Highlight tiers

- **Light yellow** `#FFF3B0` — words looked up 1–2 times (`learning` state)
- **Deep orange** `#FFD580` — words looked up ≥ 3 times (the "stuck words" you want to focus on)

---

## Privacy & security

**All data stays in your browser:**
- Vocabulary lives in IndexedDB (per-profile, isolated)
- API key lives in `chrome.storage.local` (not readable by other extensions or web pages)
- Only outbound traffic: when you trigger a lookup, the extension calls `https://api.deepseek.com` directly. **No middleman, no tracking server (not even mine).**

**Known limitations (inherent to any client-side API tool):**
- The API key travels in the `Authorization: Bearer ...` header for each call. If you open DevTools → Network, you can see your own key.
- If your Chrome profile isn't password-protected, anyone with physical access can read the key.
- **Recommendation**: create a dedicated DeepSeek key for VocabRadar and set a monthly spending cap. Worst-case leak is then bounded.

---

## Tech stack

- **Chrome Extension MV3**, vanilla JS, **zero build step**
- **IndexedDB** — local NoSQL store (`words` + `lookup_events` object stores)
- **chrome.storage.local** — settings + BYOK key
- **DeepSeek v4-flash** — context-aware translation (thinking mode disabled, JSON output)
- **Shadow DOM** — popup styling fully isolated from the host page

Dependencies: **0 npm packages**. All JS is browser-native ES modules.

---

## Project structure

```
extension/
├── manifest.json
├── background.js          # Service worker: message routing + DeepSeek + IDB writes
├── content.js             # Selection + popup + highlighter + MutationObserver + hover
├── popup.html / popup.js  # Settings + stats
├── onboarding.html / .js  # First-run welcome page
└── lib/
    ├── db.js              # IndexedDB CRUD
    ├── deepseek.js        # Direct DeepSeek API client (streaming + key test)
    ├── settings.js        # BYOK key + language pair management
    ├── i18n.js            # Translation loader for popup/onboarding
    └── translations.json  # 36 strings × 7 languages

docs/
└── retros/                # Development retros, written after each major change
```

---

## Language support

7×7 matrix (any reading language → any definition language):
- **Reading**: English / 日本語 / 한국어 / Français / Deutsch / Español / 中文
- **Definition**: same 7

UI labels (popup + lookup popup) follow the chosen *definition* language.

> Word recognition currently supports only space-delimited languages (Latin scripts + Korean). Japanese/Chinese without spaces would need different word-boundary logic; planned for a future version.

---

## Roadmap

- [x] **v0.1** — FastAPI backend + extension end-to-end (deprecated)
- [x] **v0.2** — Client-only refactor; backend deleted; BYOK; 7×7 languages
- [x] **v0.2.x** — UX polish: phrase toggle, delete button, cache short-circuit, max_tokens cap, lang-aware cache, auto-reinject on update
- [ ] **v0.3** — Auto-decay (`familiar` words untouched for 30 days drop back to `learning`)
- [ ] **v0.3** — JSON export / import for backup or device migration
- [ ] **v0.4 ?** — Chrome Web Store listing
- [ ] **v0.4 ?** — Web dashboard (vocab growth charts, search, batch edit)

---

## Development

No build step. Edit any file under `extension/`, then click the 🔄 reload button at `chrome://extensions/` to apply.

Debugging:
- **Service worker logs**: `chrome://extensions/` → VocabRadar → "service worker" link → Console
- **content.js logs**: F12 on the test page → Console → search `[VocabRadar]`
- **popup logs**: right-click the popup → "Inspect" → Console
- **IndexedDB inspection**: F12 → Application → IndexedDB → `vocab_radar`

---

## Acknowledgements

- Inspiration: noticing I'd look up the same word three times in three days while reading Reddit/Hacker News, and feeling my short-term memory was leaking.
- DeepSeek's pricing makes BYOK genuinely viable for an individual.
- Built collaboratively with Claude Code; every architectural decision is recorded under `docs/retros/`.

---

## License

MIT
