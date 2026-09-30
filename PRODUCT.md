# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Reviewers**: doctors who check and sign health articles for Tvarvi, a women's health brand in India. They mostly work on their phones, between patients or after clinic hours. On an article they read and edit about equally, so reading comes first with a quick switch to editing. They also check the AI-made social posts and pictures and mark them ready.
- **Admins**: assign reviewers, manage the team, train the AI agents (rules, examples, sources) and decide the weekly suggestions.
- **Writers**: submit articles, or have the article agent research and draft one from a topic, then check and submit it.
- **Publishers**: trusted people who publish each approved item with its own button.

## Product Purpose
An internal workflow app that takes a health article from a writer, or from the AI article agent, through a doctor's review and signature, then has AI agents prepare the website article and the Instagram, LinkedIn and X posts for a human to publish. Success means doctors can review and sign quickly and confidently on a phone, and nothing reaches the public without a person's approval.

## Positioning
Every public claim passes a doctor who signs it with their name, qualifications and photo, and every AI step is advisory, versioned and recorded: what the AI used, what it proposed, what people changed.

## Operating Context
- Long articles of 2,400–3,400 words with takeaways, 5 chapters, picture blocks, tables, FAQs and numbered references.
- Long-running AI jobs (article drafts in 5–10 minutes, social posts, carousels, website pictures, the weekly coach, the advisory audit) show progress while people wait.
- Instagram carousels are designed in Glass Slides and uploaded back; publishing may be simulated in trial mode.

## Capabilities and Constraints
- Server-rendered HTML from Node's standard library, with one package (the Anthropic SDK). Pages work without JavaScript: forms post and the server redirects. Long jobs refresh their page on a timer.
- Strict Content Security Policy: styles and images from the app itself only, no inline styles, no outside fonts, scripts or requests.
- One small self-hosted script is allowed, only for the animated thinking orbs (MIT, Jakub Antalik); every page must still work fully without it.
- Roles combine per person: admin, writer, reviewer, can publish.
- English copy; dates recorded in UTC, website dates in India's time zone.

## Brand Commitments
- Name: Tvarvi, set as a wordmark. No existing logo or brand colours; the visual identity is designed fresh (user decision).
- Visual language pinned by the user: Apple's Liquid Glass, played straight as stock iOS 26 (chosen over two custom directions after previews). The bar is Apple's own Health, Settings and Notes apps.
- Loading states use the thinking orbs (github.com/Jakubantalik/thinking-orbs).
- Articles and posts carry no em dashes.

## Evidence on Hand
Real content comes from the app's own database: articles, posts, rules, sources. There are no testimonials, metrics or marketing claims, and none should be invented.

## Product Principles
1. The doctor's reading comes first: long text must be comfortable to read and edit on a phone.
2. One clear next step per screen; secondary actions wait behind a tap.
3. AI output is advisory and always labelled as AI; people decide.
4. Every change stays traceable: versions, history and what the AI used remain one tap away.
5. Nothing public happens by accident: approving and publishing are deliberate, separated actions.

## Accessibility & Inclusion
- Phones first, with touch targets of at least 44 px and text inputs of at least 16 px so iOS does not zoom.
- Follow the system's light or dark mode, reduced motion and reduced transparency settings.
- Text contrast of at least WCAG AA over every glass surface.
