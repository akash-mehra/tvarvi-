---
version: 1
slug: "views-js"
primary_target: "views.js"
related_targets: ["public/style.css","public/orbs.js"]
---

# Surface: the whole Tvarvi app (views.js, public/style.css, public/orbs.js)

Mode: Operate, with Read for article text. Audience: doctors reviewing and signing on iPhones; admins, writers and publishers on phones or laptops. Task: review, edit and sign articles; check AI posts; publish; train the agents. Constraints: server-rendered, no framework, strict CSP, one self-hosted script for the orbs only, every page works without it.

## Direction contract

THESIS: Tvarvi as a first-party iPhone app, Apple's Liquid Glass grammar played straight (Health, Settings, Notes), refusing the generic admin dashboard of wide tables, top link bars and stacked buttons.

OWN-WORLD: systemGroupedBackground grey (pure black in dark), white inset grouped lists at 22 to 26 px radii with inset hairlines, the system font with 34 px large titles, system blue tint, system green, orange and red for state, floating Liquid Glass capsule tab bar and toolbars, glass circular nav buttons, sheets with grabbers, iOS switches and segmented controls, monochrome thinking orbs for every AI wait.

STORY: A doctor opens Home, sees what needs their signature, reads the article like a Notes page, flips to Edit with a segmented control, and signs in a sheet that shows their photo, name and qualifications. AI work shows as a calm orb with plain progress; each post has its own page with one primary action.

FIRST VIEWPORT: Home on a 390 px phone: large title with the account avatar at top right, a one-line summary, the "Assigned to you" inset list (two-line titles, status capsule, author, relative time, chevron), and the floating glass tab bar at the bottom (Home, Write, Admin, Account by role). The primary action is tapping the first row.

FORM: Stock iOS 26, the canon exit the user chose after comparing three previews; position: canon; seed key e0963067 (degraded roll). Signature interaction: the sign-and-approve sheet rising over the article. Motion: sheets and popovers slide and fade in with @starting-style; bars blur content beneath (scroll edge effect); orbs animate AI waits.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Finish record (30 Sep 2026)

- Finish review: run in the build thread, because this session does not spawn the shipped reviewer. Review disposition: fix, with seven material fixes: titles before their meta lines, the avatar on the large title's row, a one-line Home summary, AI usage as an inset list, placeholder and control-ring contrast, no stranded separator dots, and a count on the Admin tab. Verdict pass: all seven resolved and no regressions left, so ship, covering the scored fixes.
- Evidence: the captures in `.impeccable/review/`, kept out of git.
- DESIGN.md and `.impeccable/design.json` were written from the shipped stylesheet. `public/icon.png` carries its prompt provenance.
