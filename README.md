# Tvarvi

This app runs the company's content workflow from the "human input" diagram:

1. A **writer** submits an article, and it lands on the **admin** dashboard.
2. The admin **assigns a reviewer**.
3. The reviewer, a doctor, sees an advisory **AI audit** of the text and either:
   - **edits the article or asks for a second opinion**. It goes back to the admin, who sees the old and new versions (added lines green, removed lines red) and reassigns it, or
   - **approves it unchanged**, which signs it with their name and qualifications (see [Website article](#website-article)).
4. Approval starts three **AI agent complexes**, one each for Instagram, LinkedIn and X. In each one, a *writer agent* (platform algorithm and SEO) drafts a post and a *compliance agent* (medical accuracy) reviews it, for up to 3 rounds. Gemini also makes the website article's 3 pictures.
5. The reviewer checks the pictures, edits the posts if needed and marks all four items ready: the website article plus three posts. The Instagram post is either a single image or a **carousel** (see [Instagram carousels](#instagram-carousels)).
6. **Trusted people publish** each item with its own button. If the reviewer can't publish, or wants a final look, the set goes to the **publisher dashboard**.

Every step is recorded in each article's history.

A writer can also have the **article agent** research and draft an article from a topic (see [Article agent](#article-agent)). The draft opens in the new-article form, and a person checks and submits it into this same workflow.

## How the agents learn (without fine-tuning)

The agents get company knowledge and approved web sources on every run, and a weekly coach proposes improvements. **Nothing changes how the agents behave until an admin approves it.**

For each post, the app runs three agents in order:
1. **Trend scout** (only if you added trend sources). It makes one capped request with Claude's web search and web fetch, limited to 2 of each and to your approved domains. It returns trend notes, which the writer treats as untrusted. It has no other tools, so it cannot change anything.
2. **Writer.** It reads every active brand and compliance rule and the best examples, and may call two read-only tools: `get_top_posts(platform, topic)` and `search_past_articles(query)`. It hands in its post with `submit_post`, and is capped at 8 steps.
3. **Compliance agent.** It checks the post against the active compliance rules and the **approved** snapshots of your compliance pages. The writer revises until the post passes, for at most 3 reviews.

A human reviewer still approves every post before anything is published.

### AI models

Each agent's model is set with an environment variable:

| Variable | Agent | Default |
|---|---|---|
| `MODEL_WRITER` | Social post writers | `claude-sonnet-5` |
| `MODEL_ARTICLE_WRITER` | Article agent (research and writing) | `claude-sonnet-5` |
| `MODEL_CAROUSEL_WRITER` | Carousel slide text | `claude-sonnet-5` |
| `MODEL_TREND_SCOUT` | Trend scouts | `claude-sonnet-5` |
| `MODEL_COMPLIANCE` | Compliance agent (posts, articles and carousel text) | `claude-opus-5-5` |
| `MODEL_IMAGE_CHECK` | Carousel picture check and final text check | `claude-sonnet-5` |
| `MODEL_COACH` | Weekly coach | `claude-opus-5-5` |
| `GEMINI_IMAGE_MODEL` | Carousel pictures (Gemini) | `gemini-3.1-flash-image` |

- **Supported models:** `claude-fable-5-1`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5` and `claude-sonnet-4-6`; for pictures, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image` and `gemini-3-pro-image`. Any other value stops the app at startup with an error.
- **Refusal fallback:** requests to the Opus 5, Opus 5.5 and Fable 5.1 models ask the API to retry a safety-classifier refusal on a fallback model; the other models don't use that feature.
- **Recorded model:** every AI call records the model that actually served it (a fallback can differ from the one requested).
- **Changing a model:** set the variable (on Railway: Variables) and redeploy.

**What gets recorded:** each post card's **Sources used** section lists the exact rule versions, example versions, compliance page versions, web pages and past articles that post used. Every tool call is also logged in the article history.

**The tools can't leak or change data.** They are fixed, parameterized queries on a read-only database connection. They return at most 5 rows and only whitelisted fields: never users, emails, sessions or passwords. Bad or unknown tool calls return an error the model can react to.

### Agent training (admin → Training)

- **Brand rules** and **compliance rules**, for all platforms, for the **website article** only, or for one social platform. Add the brand voice guide as one brand rule titled "Voice guide". Required disclaimers and banned claims work well as separate compliance rules. Rules that only make sense for the blog (its shape, a voice with no hashtags or emoji, its calls to action) go on **Website article**, so the post writers never see them; the article agent and the final audit read those plus the all-platform rules.
- **Example posts per platform**, with optional likes, shares and reach. The best 3 go into every writer prompt.
- **Versions:** editing creates a new version and old versions are kept. You can deactivate, reactivate, or **roll back** to any earlier version, which saves it as a new version. Each version shows which posts used it.
- **Promote to example:** a button on any ready or published social post. **Save engagement** on published posts records likes, shares, reach and saves; top posts are ranked by reach + 10 × shares + 3 × likes.
- The page also shows the **measured AI cost and time** for the last 7 days, per agent and model, and the audit log. Each call is priced at its own model's list price. The price table in `ai.js` was checked in September 2026; update it if prices change.

### Sources (admin → Sources)

- Only **https** links. Each one is tagged **Compliance**, **Trends** or **Research**, and the domains you add form the allowlist.
- **Compliance pages** (regulator guidance, Instagram/LinkedIn/X health-content policies):
  - The server fetches each one right away and then daily, and stores it as a text snapshot.
  - A new or changed page shows its differences and waits for **Approve / Reject**. Until you approve it, the compliance agent keeps using the last approved version.
  - PDF pages aren't supported yet, so add the HTML version.
  - Fetching blocks private and internal addresses, re-checks every redirect against the allowlist, and stops after 2 MB or 15 seconds.
- **Trends sources** set the only domains the trend scout may search or open. Trending keywords are used only where they fit the article's facts.
- **Research sites** are the only medical sites the article agent may search, open and cite. A site covers its subdomains: `https://nih.gov` allows every `*.nih.gov` site, while `https://www.nhs.uk` allows only `www.nhs.uk`.

### Weekly suggestions (admin → Suggestions)

Once a week, or on **Generate now**, the coach reviews four things:
- how reviewers changed the AI's drafts
- the best-performing posts
- posts that failed or needed many compliance rounds
- changed compliance pages still waiting for approval (these become reminders)

It records **observations**, each with word-for-word evidence quotes and links to the posts behind them. It then proposes new rules or examples as **pending suggestions**; the coach itself can't change anything.

- **Accept or Edit** creates version 1 of a new rule or example, linked to the suggestion. **Reject** is kept, so the idea isn't proposed again. Every decision records who made it and when.
- **Limits:** at most 8 new suggestions a week. Anything with evidence that can't be verified, or that repeats an existing rule or an earlier suggestion, is dropped.
- **Thin weeks:** with fewer than 3 data points the week is skipped with a note, at no AI cost.

## Article agent

On the dashboard, a writer types a topic or keyword under **Draft an article with AI**, and optionally a **brief** (up to 2,000 characters): the coined concept, the reader's worry, prices, which Tvarvi services to mention, tags, anything else to follow. The agent then works in the background, and the draft page shows its progress live:

1. **Research.** It searches and opens pages on the **Research sites** only (Claude's web search and web fetch, restricted to those domains). It may use facts only from pages it actually opened.
2. **Writing.** It writes 2,400–3,400 words in its own words, following the brief and the active brand and compliance rules, in a fixed shape: the title, **Tvarvi Key Takeaways** (3 headings with 3 points each), exactly **5 chapters**, **3 picture blocks** (`Image 1:` title, `Description:` picture prompt, `Alt text:`), **2 tables** (`Table 1:` title, a Markdown table, `Source:`), 3 FAQs inside the chapters and 1–5 at the end. Every sentence that states a fact, figure, risk, benefit or recommendation carries a citation of the exact passage it comes from. It writes no disclaimer or byline: the app adds those.
3. **References.** The app, not the model, turns the citations into `[n]` markers and a numbered **References** list with links. Only pages the agent opened on an approved site can become references; a citation of a search snippet, or of any other page, doesn't count.
4. **Code checks** (no AI cost):
   - 2,400–3,400 words that readers read (picture blocks don't count)
   - 5–8 cited pages, all opened by the agent
   - the takeaways, 5 chapters, 3 picture blocks and 2 tables in the shape above, each picture block and table in a different chapter, and never a picture right next to a table
   - 3 FAQs inside the article, each in a different chapter, and 1–5 in a final "Frequently asked questions" section that repeat none of them; every answer 1–3 sentences
   - no links or URLs at all (the website adds its own navigation and booking buttons), and ₹ prices only as the brief gives them
   - no `[SOURCE NEEDED]` or other `[...]` placeholders, a title, and no run of 12 or more words copied from a source

   If a check fails, the agent gets the exact problems and rewrites the article. Em dashes and double hyphens are simply replaced with commas, with no rewrite and no cost; the same happens to every article a person submits or edits, so no article contains one.
5. **Compliance agent.** It checks medical compliance (the compliance rules and the approved regulator pages) and compares every cited claim with the passage it cites. It also flags any uncited sentence that states a fact. The agent revises, for at most 3 reviews.
6. **A person checks it.** The draft opens in the new-article form, next to the checks, the compliance verdict, and a **Claims and sources** table that shows each claim with its passage and link. The writer edits the draft and clicks **Submit to admin**, and it goes through the normal workflow. The article's history links to this research record, and its reviewer can open it too.

**Limits:**
- 5 versions and 3 compliance reviews per draft.
- 4 searches and 8 pages per request; after 12 pages or 6 searches, rewrites can't search or open more.
- One running draft per writer.
- A draft interrupted by a restart is marked failed, with a **Try again** button.

**Cost and time per draft** (estimates with the default models; the draft page and the Training page show the measured numbers):
- about **$0.85** and **6–9 minutes** typically
- about $0.55 and 4 minutes when the first version passes
- about $1.40 and 15 minutes in the worst realistic case
- with the article writer on Opus 5.5, about $1.20–1.60

The social posts for the article cost extra after approval (see the cost estimates under "One-week trial on Railway").

## Website article

**Signing.** Reviewers are doctors, and every article they approve carries their signature. The first time a reviewer logs in, the app asks for their signing details before anything else: the name as it should appear (for example "Dr. Mehra") and their qualifications ("MBBS, PGIMS Rohtak"). They can change them under their name at the top right; articles already approved keep the details they were signed with. Approving copies the signature and the date onto the article, and the history records it. Admins see each reviewer's details on the Team page.

**Final audit (advisory).** When an article is assigned to a reviewer, the app checks its exact text: the free code checks above, plus one compliance-agent review (`MODEL_COMPLIANCE`, about $0.10). The reviewer sees the result above the review form. It **never blocks approval**: the approval records what the audit said ("approved over the AI audit's issues"). It runs once per version of the text, so a second opinion on unchanged text reuses it, and an AI draft that passed its own review and was submitted unchanged isn't audited again.

**Pictures.** After approval, Gemini (`GEMINI_IMAGE_MODEL`) makes one 16:9 illustration for each of the article's first 3 picture blocks, from its Description, and the picture check (`MODEL_IMAGE_CHECK`) looks for text, misleading medical content, anything the picture rules forbid, a realistic person, logos and a mismatch. A flagged picture is made again with the check's notes, up to 3 times, and the best one is kept with its notes. The website card shows the pictures to the reviewer, who can ask for a **New picture** for any one of them, then **Mark ready**. Each article can use at most 15 Gemini pictures. The pictures stay private until the article is published. Without `GEMINI_API_KEY` no pictures are made, and the picture blocks are left out of the published page. Pictures cost about $0.20–0.45 per article.

**Publishing.** The website gets the article as HTML: the byline ("Written by", "Medically reviewed by" with the signature, "Last reviewed" with the approval date), the article with its pictures in place of the picture blocks, tables, links and `[n]` markers linked to their sources, then the **standard disclaimer** after the References. See [Website webhook](#website-webhook) for the payload; until it is connected, keep `website` in `DRY_RUN_CHANNELS`.

## Instagram carousels

Carousels are **off by default**: approving an article makes no carousel and spends nothing on one. The assigned reviewer turns the **Carousel** toggle on for an Instagram post only when they want one. The carousel then replaces the single image, and the post's text stays the caption. Turning the toggle off removes the carousel and its slides, and the post goes back to a single image.

1. **Slide text.** The carousel writer (`MODEL_CAROUSEL_WRITER`) turns the approved article into 5–10 slides: a cover, one point per slide, and a last slide with "General information, not medical advice" and "Full article: link in bio". Each slide has a heading (at most 60 characters), text (at most 180) and a brief for its picture.
   - Code checks the count, the lengths, and that there are no links or hashtags and the last slide has the disclaimer; the writer fixes what fails.
   - The **compliance agent** then checks every slide against the article, the compliance rules and the approved regulator pages. The writer revises, for at most 3 reviews; after that the carousel shows **Needs attention** with the issues, and no pictures are made until the text passes.
2. **Pictures.** Gemini (`GEMINI_IMAGE_MODEL`, through its REST API with Node's `fetch`) makes one 4:5 picture per slide, 3 at a time, from the slide's brief. The prompt forbids any text, identifiable people, logos, procedures, needles, blood, marked pills and anatomy diagrams: every word on a slide stays an editable text layer.
3. **Picture check.** `MODEL_IMAGE_CHECK` looks at each picture next to its slide and flags text or garbled lettering, misleading medical pictures, identifiable people, logos or brands, graphic or unsafe content, and pictures that don't fit the slide. A flagged picture is made again with the check's notes, up to 2 more times. One still flagged is kept, marked ⚠ with the notes for the reviewer.
4. **Review.** The carousel page shows each slide's picture, text and check result. The reviewer can edit the text (saving sends changed wording back to the compliance agent) or ask for a **New picture** from an edited brief.
5. **Design in Glass Slides.** **Open in Glass Slides** opens the deck in the editor (a link that works for 30 minutes), or **Download the deck file** and open it there. Each slide has the picture, a frosted panel with the heading and text, and a counter, all as separate layers. The designer adjusts them and uses **Export → Export all**, format **JPEG**, scale **1×**.
6. **Upload** the .zip that Export all saves (or the JPEGs). Tvarvi checks there is one JPEG per slide, 4:5 at 1080×1350, at most 5 MB each.
7. **Final text check.** `MODEL_IMAGE_CHECK` reads every finished slide and flags wording that differs from the approved text, or text that is cut off or unreadable, since words can change in Glass Slides after the compliance check. It advises; the reviewer decides.
8. **Checklist.** On the article page, the Instagram post shows the finished slides and seven boxes: no text in pictures, no misleading medical pictures, no identifiable people, no logos or brands, nothing graphic or unsafe, each picture matches its slide, and the finished wording matches the approved text. **Mark ready** needs every box. The ticks are saved and written to the article history. Any later change to the carousel sets the post back to draft, so it is ticked again.
9. **Publish** works as for every post: a person clicks Publish. Tvarvi creates one Instagram container per slide and a `CAROUSEL` container with them and the caption, then publishes it. In trial mode it is simulated.

**Glass Slides setup.** Set `GLASS_SLIDES_URL` to the editor's address (for example `https://glass-slides.singh-akash0717.workers.dev`). Glass Slides then fetches the deck from `PUBLIC_BASE_URL/glass/t/<token>`:
- The token is random, stored only as a hash, works for 30 minutes and is replaced by the next click.
- Only the editor's origin may read the answer (CORS), and no cookies are involved.
- Pictures travel inside the deck, because Glass Slides only accepts embedded images: about 1–2 MB per slide as PNG.
- One-click opening needs the Glass Slides change that stops a link from replacing that browser's share address and trusts Tvarvi's address. Without it, Glass Slides asks before opening and then keeps Tvarvi as its share address until reset in its Share dialog. **Download the deck file** always works.

Without `GEMINI_API_KEY` no pictures are made: the deck uses colour backgrounds and nothing is spent on pictures, so the whole flow can be tried first. Raw Gemini pictures are only shown to people who can see the article; the finished slides are public at `/media/...` because Instagram downloads them from there.

**Limits:**
- 5 to 10 slides (Instagram's API takes at most 10 per carousel), 4:5 only.
- 5 slide versions and 3 compliance reviews per run; 3 pictures per slide per run; 50 pictures per carousel from its last start.
- One job at a time per carousel. A carousel interrupted by a restart is marked failed, with a **Try again** button that keeps text that already passed.

**Cost and time per carousel** (estimates for 7 slides with the default models, prices checked in September 2026; the carousel page and the Training page show the measured numbers):
- about **$0.90** and **4 minutes** typically (1–2 pictures made again, one compliance fix)
- about $0.70 and 3 minutes when everything passes the first time
- about $2.75 and 10 minutes in the worst realistic case (10 slides, every picture tried 3 times, 3 reviews)
- at most about $4.25 when the 50-picture limit is reached
- each saved text edit adds about $0.10 (one compliance review), each New picture $0.07–0.20
- Gemini pictures are $0.067 each on Flash Image, $0.034 on Flash-Lite Image, $0.134 on Pro Image; a picture check is about $0.008
- plus the designer's time in Glass Slides, and about 2 minutes to upload and tick the checklist

**Later phase (not built):** the official Instagram Insights API for your own posts' reach and saves. It will write into the same engagement table, so `get_top_posts` picks it up unchanged. The Hashtag Search API needs Meta's approval and has a weekly hashtag cap. Instagram is never scraped.

## Run locally

Requires Node.js 22.13 or later.

```sh
npm install
cp .env.example .env                                  # set ANTHROPIC_API_KEY
npm run create-admin -- you@company.com "Your Name"   # prints a one-time password
npm start                                             # http://localhost:3000
```

Log in, open **Team**, and add writers, reviewers and publishers. Roles are checkboxes, so one person can hold several. **Can publish** is the "trusted" switch.

## One-week trial on Railway

1. Create a project from this GitHub repo. A new account gets a one-time $5 trial credit.
2. Add a **Volume** mounted at `/data`.
3. Set these variables:
   - `DATA_DIR=/data`
   - `PUBLIC_BASE_URL=https://<your-app>.up.railway.app`
   - `ANTHROPIC_API_KEY`
   - `DRY_RUN_CHANNELS=website,instagram,linkedin,x`
   - optional, for carousel and website pictures: `GEMINI_API_KEY`; for carousels: `GLASS_SLIDES_URL`
4. Open the service shell and run `npm run create-admin -- you@company.com "Your Name"`.

With every channel in `DRY_RUN_CHANNELS`, the team can use the whole workflow while nothing is posted: items show **Published (Simulated)**. Switch a channel to live by setting its keys and removing it from the list.

Costs during the trial:
- **Claude API:** billed per use. Set a spend limit in the Anthropic Console. The Training page shows the measured cost per article. Estimates:
  - about **$0.30–0.50 per article** (3 posts), and about $1.00 in the worst case, with the default models. With every agent on Opus 5.5 it is $0.50–0.80.
  - about **$0.85–1.00 for each article-agent draft** (see [Article agent](#article-agent))
  - about **$0.10 for each final audit** of an article's text, and **$0.20–0.45 for its 3 website pictures** (see [Website article](#website-article))
  - about **$0.90 for each Instagram carousel**, Gemini pictures included (see [Instagram carousels](#instagram-carousels))
  - about **$0.10–0.30 for each weekly digest**, and $0 when a week is skipped
  - about 1–2 minutes from approval until the posts are ready
- **Web search:** $10 per 1,000 searches, at most 2 per post and usually 4–6 per article draft. Web fetch costs only tokens.
- **X:** charges per post, but only once X is live.
- **Gemini:** billed per picture on the Google project of `GEMINI_API_KEY`; set a budget there too.
- **Instagram, LinkedIn, webhook:** free.

Don't use Render's free tier: it wipes the disk (database and images) whenever the app sleeps.

## Connecting the channels

| Channel | What you need |
|---|---|
| **X** | A developer account with pay-per-use credits and an app with "Read and write" permission. Generate the access token and secret for the company account. These keys don't expire. |
| **Instagram** | A professional (business or creator) account and a Meta app with content publishing permission (`instagram_business_content_publish`, or `instagram_content_publish` via Facebook Login). Set `IG_API_BASE`, `IG_USER_ID` and `IG_ACCESS_TOKEN`. Instagram fetches images from `PUBLIC_BASE_URL/media/...`, so the app must be reachable from the internet. A carousel counts as one post against Instagram's limit of 50 API posts a day. |
| **LinkedIn** | Posting to a company page needs LinkedIn to approve the Community Management API (`w_organization_social`). Until then, post as a person (`w_member_social`, `urn:li:person:<id>`) or keep LinkedIn in trial mode. |
| **Website** | Your site adds one endpoint; see below. |

Tokens for LinkedIn and Instagram Login expire after about 60 days. Renew them and update the variable. Failed publishes show the platform's error and a **Retry** button.

### Website webhook

Publishing the website item sends:

```
POST $WEBSITE_WEBHOOK_URL
Content-Type: application/json
X-Webhook-Timestamp: <unix seconds>
X-Webhook-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" using WEBSITE_WEBHOOK_SECRET>

{
  "id": 12, "title": "...", "slug": "iron-and-energy-12",
  "html": "<p class=\"byline\">Written by: ...</p><h2>...</h2><p>...</p>...<p class=\"disclaimer\">This article is for general information ...</p>",
  "byline": {"author": "Wen Writer", "reviewer": "Dr. Mehra, MBBS, PGIMS Rohtak", "reviewed": "28 September 2026"},
  "pictures": [{"n": 1, "title": "...", "alt": "...", "url": "https://<PUBLIC_BASE_URL>/media/<uuid>.png"}],
  "published_at": "2026-09-25T10:00:00.000Z"
}
```

The pictures are already in the HTML as `<img>` tags pointing at this app; the `pictures` list is there so the site can copy them to its own storage.

The endpoint must do four things:
- Verify the signature.
- Reject timestamps older than 5 minutes.
- **Upsert by `id`**, so a retry can't create a duplicate.
- Reply `2xx` with `{"url": "https://yoursite.com/articles/iron-and-energy-12"}`.

Example (Node / Next.js route handler):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export async function POST(request) {
  const body = await request.text();
  const ts = request.headers.get('x-webhook-timestamp') ?? '';
  const sig = Buffer.from(request.headers.get('x-webhook-signature') ?? '');
  const expected = Buffer.from(`sha256=${createHmac('sha256', process.env.WEBSITE_WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex')}`);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
    return new Response('Invalid signature', { status: 401 });
  }
  const article = JSON.parse(body);
  // save or update the article by article.id in your CMS/database, then:
  return Response.json({ url: `https://yoursite.com/articles/${article.slug}` });
}
```

## How it's built

- Node built-ins only (`node:http`, `node:sqlite`, `node:crypto`, `node:zlib`, `fetch`), plus `@anthropic-ai/sdk`. Gemini is called over its REST API with `fetch`.
- Server-rendered HTML forms with no client JavaScript.
- AI uses Claude with tool use (strict schemas), structured JSON output and prompt caching, with one model per agent (see [AI models](#ai-models)). There is no agent framework.
- Background jobs (the daily compliance check and the weekly digest) run inside the app. Set `BACKGROUND_JOBS=off` on any extra instance.
- The database schema upgrades itself on start (`PRAGMA user_version`); v1 data is kept.
- Security:
  - scrypt password hashing and 12-hour sessions.
  - Login lockout after 5 failures.
  - Same-origin checks on every form post and a strict Content-Security-Policy.
  - Every workflow step is a guarded state change, so double clicks can't publish twice.

| File | Purpose |
|---|---|
| `server.js` | routes, auth, workflow rules, background jobs |
| `admin.js` | Training, Sources and Suggestions pages |
| `ai.js` | trend scout, writer and compliance agents; model settings and prices |
| `article.js` | article agent: research, cited draft, code checks, compliance review; the advisory final audit |
| `pictures.js` | website pictures: Gemini picture per picture block, picture check, retries |
| `carousel.js` | carousel agent: slide text, pictures and their checks, Glass Slides deck, slide upload, final text check |
| `gemini.js` | Gemini pictures over REST |
| `tools.js` | read-only agent tools |
| `knowledge.js` | versioned rules and examples |
| `sources.js` | web sources and compliance snapshots |
| `coach.js` | weekly digest and suggestion decisions |
| `publish.js` | website, Instagram, LinkedIn and X |
| `views.js` | pages |
| `http.js` | request helpers |
| `text.js` | text helpers |
| `db.js` | schema and migrations |

```sh
npm test
```

GitHub Actions runs the same tests on Node 22 for every pull request and every push to `main` (`.github/workflows/tests.yml`).

## Known limits

- **Links:** posts don't include the article link automatically. Add it while editing if you want one; on X a link raises the post price.
- **Notifications:** there are none, so people check their dashboard.
- **Carousel slides** come back from Glass Slides by upload; there is no automatic upload.
- **Scale:** it runs as a single instance, which suits a team tool. Back up `DATA_DIR/app.db` regularly.
