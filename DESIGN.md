---
name: Tvarvi
description: Review, sign and publish Tvarvi's health articles, in an app that looks like Apple shipped it.
colors:
  system-blue: "#0071e3"
  night-blue: "#2997ff"
  grouped-grey: "#f2f2f7"
  cell-white: "#ffffff"
  label: "#000000"
  label-secondary: "rgb(60 60 67 / 0.8)"
  label-tertiary: "rgb(60 60 67 / 0.36)"
  placeholder: "rgb(60 60 67 / 0.74)"
  control-edge: "rgb(60 60 67 / 0.6)"
  separator: "rgb(60 60 67 / 0.2)"
  fill: "rgb(120 120 128 / 0.14)"
  status-green: "#1d7a36"
  status-orange: "#b25000"
  status-red: "#d70015"
  status-indigo: "#4b48c8"
  switch-green: "#34c759"
  glass: "rgb(255 255 255 / 0.66)"
  glass-strong: "rgb(250 250 252 / 0.9)"
  night-ground: "#000000"
  night-cell: "#1c1c1e"
  night-cell-raised: "#2c2c2e"
typography:
  large-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"SF Pro\", system-ui, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif"
    fontSize: "34px"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.025em"
  article-title:
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.028em"
  reading-heading:
    fontSize: "23px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.022em"
  sheet-title:
    fontSize: "20px"
    fontWeight: 700
    letterSpacing: "-0.02em"
  body:
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "-0.012em"
  reading-body:
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.62
    letterSpacing: "-0.012em"
  lede:
    fontSize: "16px"
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  subtitle:
    fontSize: "14px"
    lineHeight: 1.35
  section-header:
    fontSize: "13px"
    fontWeight: 600
  badge:
    fontSize: "12.5px"
    fontWeight: 600
  tab-label:
    fontSize: "10.5px"
    fontWeight: 600
  mono:
    fontFamily: "ui-monospace, \"SF Mono\", Menlo, Consolas, monospace"
rounded:
  control: "12px"
  callout: "18px"
  card: "22px"
  group: "24px"
  sheet: "36px"
  capsule: "999px"
spacing:
  gutter: "16px"
  row-y: "11px"
  section: "26px"
  bar-space: "108px"
components:
  button-primary:
    backgroundColor: "{colors.system-blue}"
    textColor: "{colors.cell-white}"
    typography: "{typography.body}"
    rounded: "{rounded.capsule}"
    padding: "0 22px"
    height: "50px"
  button-secondary:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.system-blue}"
    rounded: "{rounded.capsule}"
    padding: "0 22px"
    height: "50px"
  button-destructive:
    backgroundColor: "{colors.status-red}"
    textColor: "{colors.cell-white}"
    rounded: "{rounded.capsule}"
    height: "50px"
  status-capsule:
    typography: "{typography.badge}"
    rounded: "{rounded.capsule}"
    padding: "0 9px"
    height: "22px"
  list-row:
    backgroundColor: "{colors.cell-white}"
    textColor: "{colors.label}"
    padding: "11px 16px"
    height: "48px"
  inset-group:
    backgroundColor: "{colors.cell-white}"
    rounded: "{rounded.group}"
  tab-bar:
    backgroundColor: "{colors.glass}"
    typography: "{typography.tab-label}"
    rounded: "32px"
    height: "64px"
  sheet:
    backgroundColor: "{colors.glass-strong}"
    rounded: "{rounded.sheet}"
    padding: "8px 20px 20px"
---

# Design System: Tvarvi

## Overview

**Creative North Star: "The First-Party App"**

Tvarvi should look as if Apple shipped it next to Health, Settings and Notes. It uses iOS 26's Liquid Glass played straight: grouped system grey, white inset lists, 34px large titles, system blue for anything tappable, and glass only on the bars, buttons and sheets that float over content. The brand shows in restraint, not in chrome. The article text is the content, and it gets the calmest page.

The density is standard iOS: one idea per screen and one primary action per page, in the floating toolbar. Everything secondary or rare waits in a sheet. Motion is the platform's own: sheets rise and fade, bars blur the content that scrolls under them, and a large title hands over to a small bar title as it scrolls away. Every wait on the AI shows a monochrome thinking orb with plain progress text, never a spinner.

The rejected reference is the generic admin dashboard, with its wide tables, top link bars and rows of stacked buttons.

**Key Characteristics:**
- Grouped grey ground (#f2f2f7), or pure black in dark mode, under white inset lists with 24px corners.
- The system font only (SF Pro on Apple devices): 34px bold large titles and 17px body.
- A floating glass capsule tab bar on phones, which moves to the top on screens 1024px wide and up, as on iPad.
- One primary action per page, in a floating toolbar. Everything else is in a sheet.
- Colour means state or action. Nothing is tinted for decoration.
- Thinking orbs for every AI wait, drawn in the label colour.

## Colors

The palette is Apple's system palette, darkened where iOS's own hues miss WCAG AA on white.

### Primary
- **System Blue** (#0071e3): links, the primary button fill, the selected tab, focus rings and caret. It is darker than iOS's #007aff so that blue text reaches 4.5:1 on white.
- **Night Blue** (#2997ff): blue text and icons in dark mode. Button fills stay System Blue in both modes.

### Tertiary
- **Status Green** (#1d7a36): the Published, Ready, Active and Passed text on a 16% green fill.
- **Status Orange** (#b25000): Waiting for admin, Pending, Simulated and warning callouts, on a 17% orange fill.
- **Status Red** (#d70015): failures, destructive buttons, count badges and errors, on a 12% red fill.
- **Status Indigo** (#4b48c8): the AI's work, such as Preparing posts, Generating and AI callouts, on a 13% indigo fill.
- **Switch Green** (#34c759): the track of a switch that is on, the one place the raw iOS hue survives. Its white knob and position carry the state.

### Neutral
- **Grouped Grey** (#f2f2f7): the page ground everywhere except while reading.
- **Cell White** (#ffffff): inset lists, cards, callouts and the reading page's ground.
- **Label** (#000000): titles and body text.
- **Secondary Label** (rgb(60 60 67 / 0.8)): subtitles, meta lines, section headers and footers. It measures about 6:1 on white.
- **Tertiary Label** (rgb(60 60 67 / 0.36)): chevrons, grabbers and timeline dots only. It is never used for text.
- **Placeholder** (rgb(60 60 67 / 0.74)): placeholder text, at 5.0:1 on white and 4.7:1 on grey.
- **Control Edge** (rgb(60 60 67 / 0.6)): the rings of unchecked checkmark circles and radios, at 3.4:1.
- **Separator** (rgb(60 60 67 / 0.2)): 0.5px hairlines inside inset lists.
- **Fill** (rgb(120 120 128 / 0.14)): secondary buttons, the segmented control track, grey capsules and the selected tab's pill.
- **Night Ground, Night Cell and Night Cell Raised** (#000000, #1c1c1e, #2c2c2e): the dark-mode ground, cells, and sheet or raised cells.

### Named Rules
**The System Colour Rule.** Colour means state or action, never decoration. Blue is what you can tap. Green, orange, red and indigo are statuses. Everything else is grey, black or white.

**The Contrast-Safe Tint Rule.** Status text uses the darkened tones over their soft fills, never the raw iOS system hues on white. In dark mode the brighter tones (#30d158, #ff9f0a, #ff6961, #9d9bff) take over.

## Typography

**Display and Body Font:** the system stack (SF Pro on Apple devices, then system-ui, Segoe UI, Roboto and Helvetica Neue).
**Mono Font:** ui-monospace (SF Mono), only for text diffs and code.

**Character:** one family, as on iOS. The hierarchy comes from size, weight and tight negative tracking, never from a second face.

### Hierarchy
- **Large Title** (700, 34px, 1.12): the title of every top-level page (Home, Write, Admin, Account), with the account avatar on the same row.
- **Article Title** (700, 30px, 1.15, balanced): the heading of a detail page (an article, a post, a rule, a draft).
- **Reading Heading** (700, 23px, 1.25): chapter headings inside an article.
- **Sheet Title** (700, 20px): centred at the top of a sheet.
- **Body** (400, 17px, 1.35): interface text. Row titles use weight 500.
- **Reading Body** (400, 18px, 1.62, at most 68ch): article text in Read mode.
- **Lede** (16px, 1.4, secondary label): the one-line summary under a large title.
- **Subtitle** (14px, 1.35, secondary label): row metadata. Items are separated by dots that never end or start a line.
- **Section Header** (600, 13px, secondary label): the label above an inset list.
- **Badge** (600, 12.5px): status capsules.
- **Tab Label** (600, 10.5px): under each tab icon.

### Named Rules
**The Large Title Rule.** Every page opens with its title. On detail pages the small title in the bar stays hidden until the large one scrolls away.

**The Title-First Rule.** Status capsules, bylines and meta lines sit under a heading, never above it.

## Layout

Everything is one column: at most 760px wide, or 1040px for the Training page, centred, with 16px side gutters plus the safe areas. Sections are 26px apart, and a section header sits 7px above its list. Rows are at least 48px tall with 11px by 16px padding. The bottom of every page reserves 108px plus the safe area, so the last row clears the floating bars.

- **Phones:** the tab bar floats 10px above the bottom edge. It is a 64px capsule, 236px wide for two tabs, 340px for three and 440px for four. Detail pages swap it for a floating toolbar holding the page's one or two actions, and a glass back button sits top left in a transparent bar.
- **1024px and wider:** the tab bar moves to the top centre, as on iPad. On detail pages the back button and the page's actions share that row, and the bar's small title stays hidden.
- **Sheets:** on phones they rise from the bottom, inset 8px from the edges. From 700px they become centred form sheets 540px wide, without a grabber.
- The layout holds at 320px with no sideways scrolling. Toolbar buttons size to their labels and end in an ellipsis rather than wrapping.

## Elevation & Depth

Depth is mostly tonal: the grey ground, then white cells, then raised cells in dark mode. Glass is added for anything that floats over content. Glass is a 24px backdrop blur at 1.9 saturation (30px for sheets), with a specular top edge (an inset 0.5px white highlight) and a hairline rim. Bars blur the content that scrolls under them and wash it toward the page colour, like iOS's scroll-edge effect. With Reduce Transparency on, every glass surface turns solid.

### Shadow Vocabulary
- **Card hairline** (`box-shadow: 0 1px 2px rgb(0 0 0 / 0.04)`): inset lists and cards in light mode. Dark mode has none.
- **Glass lift** (`box-shadow: 0 14px 32px -12px rgb(0 0 0 / 0.24), 0 2px 6px rgb(0 0 0 / 0.05)`): the tab bar, toolbar and glass buttons.
- **Sheet** (`box-shadow: 0 24px 60px -12px rgb(0 0 0 / 0.35)`): a sheet over its 22% black scrim (50% in dark mode).
- **Button glow** (`box-shadow: 0 8px 20px -10px rgb(0 113 227 / 0.65)`): under filled buttons only, in red (rgb(215 0 21 / 0.6)) for destructive ones.

### Named Rules
**The Floating Glass Rule.** Glass is only for controls that float over content: the tab bar, the toolbar, round navigation buttons and sheets. Content surfaces are opaque.

## Shapes

Large, soft, continuous corners: 24px for inset groups, 22px for cards, 18px for callouts, 12px for controls and 36px for sheets. Buttons, badges, segmented controls and the tab bar are full capsules, and the round navigation buttons are circles. Cells have no borders. Rows are divided by 0.5px hairlines inset 16px from the leading edge, or 60px after an icon.

## Components

### Buttons
Buttons feel solid and tappable: capsules that press to 97% scale.
- **Shape:** full capsule (999px), at least 50px tall. Small buttons are 36px.
- **Primary:** System Blue fill, white 17px semibold label, 22px side padding and the primary glow.
- **Secondary:** a grey fill with a blue label and no shadow. **Plain:** a blue label only, used for Cancel. **Destructive:** a red fill, or a red label on a soft red fill for the secondary form.
- **Hover / Focus / Active:** brightness 1.06 on hover, a 3px System Blue focus ring offset 2px, and 0.97 scale on press. Disabled is 45% opacity.

### Status capsules
- **Style:** a 22px capsule holding a 12.5px semibold label in the status tone over its soft fill. A 14px orb leads the capsule while the AI works.
- **Placement:** in meta lines and row subtitles, under the heading they describe.

### Inset lists and rows
- **Corner Style:** 24px groups on the grouped grey.
- **Rows:** an optional 30px coloured icon tile with 8px corners, a 17px title (two lines at most), a 14px subtitle, and a trailing value, count badge or 14px chevron.
- **States:** a 9% grey wash on hover and 20% on press. Destructive rows are centred and red.

### Cards and callouts
- **Cards:** white, 22px corners, 16px padding and the card hairline, for text, forms and media rather than rows.
- **Callouts:** 18px corners with a leading icon, tinted per tone (info, ai, ok, warn, error). Error callouts are alerts.

### Inputs and fields
- **Style:** fields live inside inset lists. A 13px secondary label sits over a borderless 17px input, and the label turns blue while the field has focus.
- **Choices:** switches are 51 by 31 capsules drawn over real checkboxes. Checkmark circles and radios are 24px rings in Control Edge that fill blue when chosen. The segmented control is a capsule track with a white pill on the chosen segment.

### Navigation
- **Tab bar:** a glass capsule with a 25px icon over a 10.5px label for each tab. The current tab is blue on a grey pill. The Admin tab carries a red count badge while suggestions or changed compliance pages wait.
- **Top bar:** transparent, with a glass back capsule at the leading edge and round glass action buttons at the trailing edge. The small title fades in once the large title scrolls away.
- **Toolbar:** floating at the bottom of detail pages: an optional round More button, a secondary action, then the primary.

### Sheets (signature component)
The sign-and-approve sheet rises over the article on a scrim, with a grabber, a centred title and the signature card (photo, "Medically reviewed by", name, qualifications and date). Under the card come Sign and approve, Send to the admin instead, and Cancel. A sheet opened from a sheet stacks on it, and the one beneath shrinks to 94%. Without Popover API support, sheets render inline in the page.

### Thinking orbs
Monochrome dot spheres drawn by the one self-hosted script, in the label colour. They come in three sizes: 20px in capsules and callouts, 64px, and a 128px hero on waiting pages. They pause when offscreen or when the tab is hidden, hold one still frame under Reduce Motion, and are hidden when scripting is off.

## Do's and Don'ts

### Do:
- **Do** give every page one primary action in the floating toolbar, and put secondary and rare actions in a sheet.
- **Do** put a page's status capsule and meta lines under its title.
- **Do** show every AI wait as a thinking orb with plain progress text (20px, 64px or 128px).
- **Do** keep text at 4.5:1 or better, using the Placeholder token for placeholders, and keep control rings at 3:1 using Control Edge.
- **Do** render data as inset list rows: a title, a subtitle of facts separated by dots, and a trailing value.

### Don't:
- **Don't** build wide tables, top link bars or rows of stacked buttons.
- **Don't** put glass on content surfaces or use it as decoration.
- **Don't** place a label, status or kicker above a heading.
- **Don't** use Tertiary Label for text.
- **Don't** load fonts, scripts or images from other origins. The content security policy allows only the app's own files.
