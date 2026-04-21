# Todd's Pizzeria — Rent Roll the Dough
## Walkthrough Test Plan

Use this to verify every stage of the pipeline on a given property (Argus RR + Client RR pair). Map each bullet to what you see on screen.

---

### Stage 0 — Arrival
- [ ] Site loads at the live URL
- [ ] Header says **Todd's Pizzeria** · subtitle reads **Rent Roll the Dough · vegetarian · kosher · served bit by bit**
- [ ] Bottom-right footer shows `🟢 kitchen online` (health check)
- [ ] `🧀 Extra cheese (Opus 4.7)` toggle visible top-right

### Stage 1 — Place your ingredients (upload)
- [ ] Two drop zones side by side
- [ ] Left zone shows **Asparagus (Argus)** + pixel asparagus sprite + green dashed border
- [ ] Right zone shows **Cilantro (Client)** + pixel cilantro sprite + green dashed border
- [ ] Hint text says "or Cilantro — we'll figure it out" (and vice versa) — it's OK to drop files in either slot
- [ ] Drag-drop OR click-to-browse both work
- [ ] After a file drops: border goes solid green, filename appears in green, veggie sprite bounces
- [ ] "Sort the ingredients →" button is disabled until BOTH files are in; then it lights up orange

### Stage 2 — Ingredient check (auto-detect)
- [ ] Triggered after clicking "Sort the ingredients"
- [ ] Two cards: 🥬 **ASPARAGUS · ARGUS** (olive-green border) and 🌿 **CILANTRO · CLIENT** (green border)
- [ ] Each card shows filename + detection hits + score (Argus usually 15–19, Client usually negative)
- [ ] Middle `⇄` swap button: if Todd got it wrong, click to swap — cards should swap filenames and hits
- [ ] "🍕 Roll the dough" button ships you to baking

### Stage 3 — Baking (SSE stream, 6 sub-stages)
The 32-bit kitchen scene should go through these in order, with the progress bar filling and the headline changing:

| % | Pixel headline | Kitchen should show |
|---|---|---|
| 5 | KNEADING DOUGH | Chef kneading, dough at 70% scale wobbling |
| 15 | KNEADING DOUGH | (same — loading 2nd file) |
| 25 | TOSSING DOUGH | Dough full size, spinning clockwise |
| 45 | SPREADING SAUCE | Red sauce fades in on dough, chef stirring arm |
| 65 | SPRINKLING VEGGIES | Cheese + olives/peppers/mushrooms/basil appear; veggie-rain emoji fall across kitchen |
| 80 | BAKING IN THE OVEN | Pizza slides into oven, oven lights up orange, embers fly up, chef desaturated |
| 95 | DING! | (brief, before transition to results) |

- [ ] Bell sound plays when complete (tiny WebAudio beep)
- [ ] Progress message text changes per stage
- [ ] No browser console errors during the stream

### Stage 4 — Results
- [ ] Big "🔔 DING! 🔔" banner (pixel red)
- [ ] Subline shows: `Property: <name> · <N> Argus tenants · <M> client tenants`
- [ ] Stats grid shows 5 cards: Matched pairs / Clean matches (green) / With differences (red if any) / Argus only (orange if any) / Client only (orange if any)
- [ ] Top-discrepancy preview lists up to 10 rows with Suite | Tenant | Argus value | Client value | Severity
- [ ] "⬇ Download Excel report" button downloads an `.xlsx`
- [ ] "Start a new order" button resets and returns to upload

### Stage 5 — Excel output (open the download)
- [ ] Tab 1 "Argus RR" — one row per tenant parsed from the Argus file, dark-blue header row
- [ ] Tab 2 "Client RR (normalized)" — same columns, data from the Client file in Argus shape, dark-green header
- [ ] Tab 3 "Reconciliation" — main sheet:
  - First header row: grouped sections (TENANT NAME, SQUARE FOOTAGE, LEASE START, LEASE END, CURRENT RENT, STEPS, STATUS, EVIDENCE)
  - Second header row: Argus | Client | ✓ per field
  - Each data row color-coded: green = match, red = differences, orange = argus-only or client-only
  - Evidence column (far right, wide) has a plain-English summary per row
- [ ] Tab 4 "Summary" — property name, generation timestamp, stats

### Stage 6 — Reality-check the output (manual spot check)
Pick **3 tenants** from the Reconciliation tab:
1. One with **STATUS = MATCH** → confirm every ✓ is correctly green; Argus vs Client values actually agree on your source files
2. One with **STATUS = DIFFERENCES** → confirm the flagged field actually differs when you eyeball both source files (don't trust the LLM blindly)
3. One with **STATUS = ARGUS ONLY** or **CLIENT ONLY** → confirm the tenant really is absent from the other side (could be a suite-name mismatch the matcher missed)

---

### Edge cases to also test
- [ ] Upload same file twice (should still run, detection will show Argus for both; one should swap)
- [ ] Upload PDF + PDF (Mayfair style) — expect dense line-item handling
- [ ] Upload XLSX + XLSX (Vintage style)
- [ ] Upload PDF + XLSX (Northwood style)
- [ ] Toggle 🧀 Extra cheese ON — pipeline should run identically but slower, more accurate
- [ ] Refresh mid-bake — the flow should reset cleanly (no stuck state)
- [ ] Scanned PDF — should fail gracefully with a readable error (not silent 0 tenants)

### What known-good looks like (from smoke test on 2026-04-21)
| Property | Argus tenants | Client tenants | Matched | Clean | Diffs |
|---|---|---|---|---|---|
| Northwood Plaza | 65 | 35 | 35 | 12 | 23 |
| Vintage Marketplace | 26 | 15 | 15 | 0 | 15 |
| Mayfair Shopping Center | 67 | (varies — chunked) | — | — | — |

Notable catches the system is expected to surface:
- **Northwood / Pizza Hut (Suite 02A)** — lease-end 2/28/2031 (Argus) vs 2/28/2026 (Client) **[HIGH]**
- **Vintage / Suite A100** — "Orange Theory" (Argus) vs "HZ Heart Fit, LLC (Orange Theory)" (Client) **[LOW]**
- **Northwood / Back Again Book Shop** — effective date 6/1/2025 (Argus) vs 5/1/2025 (Client) **[HIGH]**
