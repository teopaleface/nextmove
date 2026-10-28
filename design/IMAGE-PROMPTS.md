# NextMove mobile ImageGen prompt set

Generation method: built-in `image_gen.imagegen`, requested through Codex; no CLI/API fallback. Each board is a design reference, not implementation evidence. English UI, fictional merchants and account data. Full design tokens and exact amounts come from DESIGN-SYSTEM.md and ui-fixtures.json.

## Visual revision v2

The earlier prompts and outputs below are retained as generation history. Current visual authority is [the native mobile preview](mobile-preview.html) and the updated [design system](DESIGN-SYSTEM.md). This revision was built in HTML/CSS; it does not claim a new ImageGen run.

For future image generation, use a rendered v2 screen as the visual reference. Preserve the bank's yellow/black identity, native phone type, aligned financial rows, grouped account balances and single primary task action. Passive task states use a 14px outline icon and quiet text without a colored pill. Use amber only for an attention icon, green only for a confirmation accent and red for actual failure. Keep `Demo` as header metadata. Avoid a repeated rounded-card grid, colorful merchant decoration, AI sparkles and invented usage charts. Carry forward all canonical dates, financial conditions and permission rules.

## Generated boards

- Board 1: banking and agent entry, prompt below.
- Board 1 final correction: [align historical payments with renewal dates](prompts/01-banking-date-correction.txt); selected output `mockups/01-banking-and-agent-v2.png`.
- Board 2: [evidence, comparison, approval and browser](prompts/02-agent-workflow.txt); output `mockups/02-agent-workflow.png`.
- Board 2 correction: [explicit next-30-day labels](prompts/02-agent-workflow-correction.txt).
- Board 3: [confirmed result, goals, purchase and home plan](prompts/03-results-and-goals.txt); output `mockups/03-results-and-goals.png`.
- Board 4: [business, refund tracking, travel and changed terms](prompts/04-business-recovery-and-travel.txt); output `mockups/04-business-recovery-and-travel.png`.

## Board 1 — Banking and agent entry

Initial generation target: `mockups/01-banking-and-agent.png`; retained as `mockups/drafts/01-banking-and-agent-v1.png`. The selected corrected final is `mockups/01-banking-and-agent-v2.png`.

```text
Use case: ui-mockup.
Create a polished, implementation-ready MOBILE BANKING UI design board for the fictional app "NextMove". Four full portrait phone screens side by side, all equally large, aligned, front-facing flat screen designs. Wide high-resolution board, ideally approximately 3000 by 1800, with generous light-neutral gutters. No perspective, no hands, no desktop UI, no large hardware frames. Render the ENTIRE 390x844-style screen including top status area and bottom tab bar. Screens must be readable, consistent and visually detailed.

Style: inspired by the restrained yellow/black identity and clear account hierarchy of Raiffeisen Smart Mobile, but an original fictional NextMove identity. Warm ivory background #F7F7F2, white cards, ink #151515, bright action yellow #FEE600, thin warm-gray separators, subtle green status only. Inter-like modern sans serif, large tabular financial numerals, 16px-equivalent body, comfortable spacing, 16px card corners, modest 12px button corners. Mostly flat with very little shadow. White account cards, selective yellow buttons, a secondary black virtual debit card if appropriate. Small geometric N mark and "NextMove" wordmark. No Raiffeisen logo, no crossed hammers, no purple, no gradients, no glass, no 3D coins, no AI orb.

All customer UI copy is ENGLISH. A small "Demo" chip near the header. Consistent bottom navigation with simple outline icons and labels exactly "Home", "Activity", "Goals", "Agent". Each screen uses its correct selected tab. Use a coherent single fictional user Alex. Amounts and exact labels below must be spelled accurately; omit unnecessary fine print rather than produce gibberish. Small external captions under the screens: "01 Home", "02 Activity", "03 Subscriptions", "04 Agent".

SCREEN 1 HOME, selected Home:
Compact header with NextMove wordmark, Alex avatar and notification icon. Friendly "Hello, Alex". Main white balance card with eyebrow "Total balance", large "110,000.00 RON"; account breakdown "Daily 12,480.00" and "Savings 97,520.00". Three compact banking shortcuts "Send", "Request", "Cards", primary one yellow. Agent finding card with small yellow N icon, heading "A little less leaving your account", prominent "153 RON", small line "Potential reduction · next 30 days", yellow CTA "Review 3 options". Under it a compact "First home" progress card "110,000 / 130,000 RON". Balanced hierarchy, no crowding.

SCREEN 2 ACTIVITY, selected Activity:
Title "Activity", search icon, segmented controls "Transactions" and "Upcoming", Transactions active. A compact white row linking "Subscriptions" with "163 RON / month" and a small warning "1 trial ends soon". Date label "This week". Spacious transaction list: "Streamly" "-49.00 RON"; "StudyPlus" "-79.00 RON"; "CloudBox" "-35.00 RON"; "Fresh Market" "-128.40 RON". Fictional simple initial icons. A further smaller row "Refunds & claims" with "View status". All transaction amounts align right.

SCREEN 3 SUBSCRIPTIONS, selected Activity:
Back control and title "Subscriptions". White summary with large "163 RON", label "Current paid plans / month". Pale yellow alert card "FitFlow trial ends in 2 days", "79.00 RON on 30 Oct", action "Review trial". Active/Trials segmented controls or clear section labels. Three clean rows: "StudyPlus" "79.00 RON / month", "Streamly" "49.00 RON / month", "CloudBox" "35.00 RON / month". A small agent suggestion "Cloud storage may already be included". Show the free trial separately; do not include it in the paid 163 total. Primary bottom action "Find better options".

SCREEN 4 AGENT, selected Agent:
Title "Your next move" with modest yellow N mark. Short supporting copy "What would you like to work on?" Four compact suggestion rows "Review subscriptions", "Plan a purchase", "Explore a home", "Grow my business". Active task card "Subscription review", badge "Ready to review", "3 options found", highlighted "153 RON potential / next 30 days", button "Review plan". Bottom composer above navigation with text "Ask NextMove…" and attachment icon, small "Add screenshot" affordance. This is a capable action-oriented agent embedded in a bank, not a generic messaging app.

Make every screen feel like the SAME real shipped banking product. Keep safe areas, one main CTA per section, clear short copy, clean whitespace, aligned labels and amounts. The values are fictional; this is a design concept, not a real bank account. Do not add marketing slogans around the board or official financial-provider logos.
```
