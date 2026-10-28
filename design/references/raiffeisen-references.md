# Raiffeisen Romania visual references for NextMove

Researched 28 October 2026. Read-only public-source research for the phone-only NextMove concept. No app implementation, account actions or image generation. Observations below describe official published screenshots and documentation, not a hands-on authenticated app test.

## Useful design direction

Use the **Smart Mobile personal dashboard** as the closest visual starting point: a warm light canvas, white account cards, a prominent balance, compact banking shortcuts and a simple bottom navigation. Borrow the **Smart Business** habit of keeping account context, monetary amounts and the next action together. Keep NextMove's own identity and the agent visible within this banking structure.

The four downloaded images are official publisher screenshots distributed through Apple's CDN. Personal images are 600 × 1300; business images are 600 × 1298. All are JPEGs; together approximately 325 KB. They are reference images containing marketing framing and device bezels, not clean app exports. They should inform the new design rather than be pasted into the NextMove UI.

## Observed cues and their sources

### Smart Mobile: current published personal reference

Source: [Raiffeisen Smart Mobile, Romanian App Store listing](https://apps.apple.com/ro/app/raiffeisen-smart-mobile/id1255136212?platform=iphone), publisher Raiffeisen Bank Romania S.A. The [official developer listing](https://apps.apple.com/ro/developer/raiffeisen-bank-romania-s-a/id470512473?l=ro) identifies both banking apps.

Observed in [the dashboard screenshot](smart-mobile-second-screen.jpg):

- The app interior is mostly warm light neutral and white; large yellow areas belong primarily to the surrounding marketing artwork.
- A compact header combines a profile circle, friendly greeting and message/benefit icons. This gives banking a human tone without a large illustration consuming the app screen.
- A white rounded account card puts the balance above the account description. The amount dominates; the currency and decimals are quieter.
- Three shortcuts sit inside the account card: Pay, Transactions and Details. Yellow marks the primary shortcut; the others use simple outlined containers and dark icons.
- A small carousel indicator communicates additional accounts. A secondary offer card sits below the banking card.
- Four labelled bottom destinations are visible: Dashboard, Payments, Cards and Products. Simple icons accompany text. This is evidence for a compact four-item pattern, not a reason to copy these destinations into NextMove.
- Sans-serif type, dark text, restrained icon strokes and generous separation give the monetary content hierarchy. The exact font family, sizes and spacing cannot be verified from a marketing image.

The [authentication screenshot](smart-mobile-third-screen.jpg) shows a native Face ID surface over the app. It supports using familiar mobile authentication patterns. It does not show an AI approval flow or establish NextMove's approval design.

The [official Google Play listing](https://play.google.com/store/apps/details?hl=en&id=ro.raiffeisen.smartmobile) documents a configurable dashboard, account-balance visibility controls, payment forms and transaction search/reuse. These are product descriptions, not additional observed runtime behavior.

### Smart Business: official published business reference

Sources: [Smart Business App Store listing](https://apps.apple.com/ro/app/raiffeisen-smart-business/id1482741887), [Raiffeisen Romania product page](https://www.raiffeisen.ro/ro/imm/produse-si-servicii/servicii-electronice/mobile-banking-smart-business.html).

Observed in [the dashboard screenshot](smart-business-dashboard.jpg):

- A compact company header precedes a vertically stacked account list. Each account groups its identity, account number, balance and payment action.
- White rows alternate with light-gray separators/action areas. Amounts align right; the balance is bold and currency remains explicit.
- A yellow payment strip spans much of each row. Card access is a separate row below the account list.
- Four labelled bottom items cover portfolio, payments, authorizations and statements. This is a denser layout than the personal screenshot.

Observed in [the payment screenshot](smart-business-payments.jpg):

- One vertically scrolling form groups source account, recipient, amount/currency, description and payment date.
- Gray section bands separate white fields. A short progress line is visible near the top.
- A contextual information block appears close to the amount. A yellow continuation action sits at the bottom of the visible screen.

The business product page documents multi-user rights and joint signatures, notifications, statements and card details. For NextMove, the relevant inference is to make the selected personal/business context and authorized actor explicit. We did not test those controls.

### Official guide: secondary reference within the primary-source set

[Smart Mobile user guide, official PDF](https://www.raiffeisen.ro/content/dam/rbi/retail/eu/ro/documents/smart-mobile-ghid.sv.pdf). It separates dashboard, payments, future payments, savings/planning and preferences. Use it for functional grouping; do not treat every guide illustration or its release date as a verified match to the latest installed app. The guide and the App Store screenshots can represent different revisions.

## Identity palette: evidence versus NextMove proposals

**Observed:** saturated yellow, dark/black typography, white and light neutral app surfaces. Both official screenshot sets establish this visual family. The public pages inspected here did not provide a verified official brand-token specification. No hex below should be called an official Raiffeisen value.

**Proposed by the parent design task for NextMove:** yellow `#FEE600`, ink `#151515`, canvas `#F7F7F2`, white cards, Inter/system sans. These are our design choices. Warm off-white is compatible with the personal reference; using yellow selectively for actions will make a phone screen easier to scan than reproducing the promotional yellow surrounds.

**NextMove-specific decisions, not observed Raiffeisen conventions:** 390 × 844/852 reference size, minimum 44px interaction targets, 16px body copy, Home / Activity / Goals / Agent navigation, an expandable agent-task sheet containing browser evidence, contextual feature discovery, approval summaries and merchant-confirmed outcomes. No Raiffeisen logo or partnership claim is needed. Preserve the distinct fictional NextMove brand.

## Application to the mockups

- Home: greet Alex, show total liquid balance and its account breakdown, then the agent finding and home goal. Give banking numbers visual priority.
- Put subscriptions, upcoming payments and account details behind banking cards or Activity. Keep the four root destinations stable; avoid a destination for every capability.
- Use rounded white cards from the personal reference for findings and comparisons. Use the business reference's tighter label/value grouping when reviewing invoices, inventory costs or payment approvals.
- Keep one clear primary action per decision card or sheet. Yellow needs dark text/icons. Pending, confirmed and changed-terms states also need explicit words.
- The agent browser belongs in an expandable phone task sheet. A screenshot or merchant response is supporting evidence below task status, not a desktop dashboard occupying the phone.
- Approval should show the exact merchant, action, cost/benefit, effective date and relevant terms. After execution, show the merchant confirmation separately from bank balance changes. This behavior comes from the approved product scope, not the reference apps.
- Use only canonical NextMove scenario numbers supplied by the parent task. Screenshot balances, real offers and real merchant terms are reference content, not demo fixtures.

## Downloaded image provenance

1. **Personal dashboard:** [smart-mobile-second-screen.jpg](smart-mobile-second-screen.jpg), 90,748 bytes. Source page: Smart Mobile listing above. Exact asset URL: https://is1-ssl.mzstatic.com/image/thumb/PurpleSource221/v4/53/72/a6/5372a63e-6e27-1821-eaef-3541e2744237/iOS_Screen_2.png/600x1300bb-60.jpg
2. **Personal authentication:** [smart-mobile-third-screen.jpg](smart-mobile-third-screen.jpg), 49,507 bytes. Source page: Smart Mobile listing above. Exact asset URL: https://is1-ssl.mzstatic.com/image/thumb/PurpleSource221/v4/96/f0/2e/96f02eb9-ecd3-4dc0-7626-1f070d256199/iOS_Screen_3.png/600x1300bb-60.jpg
3. **Business dashboard:** [smart-business-dashboard.jpg](smart-business-dashboard.jpg), 98,319 bytes. Source page: Smart Business listing above. Exact asset URL: https://is1-ssl.mzstatic.com/image/thumb/PurpleSource221/v4/81/7c/28/817c2881-1d1f-2398-d0c2-456ca90b04db/2_Dashboard.png/600x1300bb-60.jpg
4. **Business payment form:** [smart-business-payments.jpg](smart-business-payments.jpg), 86,281 bytes. Source page: Smart Business listing above. Exact asset URL: https://is1-ssl.mzstatic.com/image/thumb/PurpleSource221/v4/76/3d/88/763d882b-eaf0-3edd-d307-cce709889bdf/3_Payments.png/600x1300bb-60.jpg

## Access and verification limits

The required TypeSafe Jev 1.14 + vision launcher was attempted against the requested starting URL using the existing Helium workflow. It stopped with: **“Helium is already running, but without remote debugging on port 9333.”** No restart, second profile, login or private browser screenshot was used. Research continued through public web search and direct static HTTP retrieval.

The supplied Smart Mobile starting URL returned HTTP 404 on direct retrieval: `https://www.raiffeisen.ro/ro/persoane-fizice/in-sprijinul-tau/digital-banking/smart-mobile.html`. The official store listings, developer listing, business page and guide supplied the usable evidence. All four saved assets were opened and visually inspected. This workspace is not a Git checkout, so Git-based diff verification is unavailable; changes are confined to `design/references/`.
