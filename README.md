# Tvarvi

This app runs the company's content workflow from the "human input" diagram:

1. A **writer** submits an article, and it lands on the **admin** dashboard.
2. The admin **assigns a reviewer**.
3. The reviewer either:
   - **edits the article or asks for a second opinion**. It goes back to the admin, who sees the old and new versions (added lines green, removed lines red) and reassigns it, or
   - **approves it unchanged**.
4. Approval starts three **AI agent complexes**, one each for Instagram, LinkedIn and X. In each one, a *writer agent* (platform algorithm and SEO) drafts a post and a *compliance agent* (medical accuracy) reviews it, for up to 3 rounds.
5. The reviewer edits the posts if needed and marks all four items ready: the website article plus three posts.
6. **Trusted people publish** each item with its own button. If the reviewer can't publish, or wants a final look, the set goes to the **publisher dashboard**.

Every step is recorded in each article's history.

## How the agents learn (without fine-tuning)

The agents get company knowledge and approved web sources on every run, and a weekly coach proposes improvements. **Nothing changes how the agents behave until an admin approves it.**

For each post, the app runs three agents in order:
1. **Trend scout** (only if you added trend sources). It makes one capped request with Claude's web search and web fetch, limited to 2 of each and to your approved domains. It returns trend notes, which the writer treats as untrusted. It has no other tools, so it cannot change anything.
2. **Writer.** It reads every active brand and compliance rule and the best examples, and may call two read-only tools: `get_top_posts(platform, topic)` and `search_past_articles(query)`. It hands in its post with `submit_post`, and is capped at 8 steps.
3. **Compliance agent.** It checks the post against the active compliance rules and the **approved** snapshots of your compliance pages. The writer revises until the post passes, for at most 3 reviews.

A human reviewer still approves every post before anything is published.

**What gets recorded:** each post card's **Sources used** section lists the exact rule versions, example versions, compliance page versions, web pages and past articles that post used. Every tool call is also logged in the article history.

**The tools can't leak or change data.** They are fixed, parameterized queries on a read-only database connection. They return at most 5 rows and only whitelisted fields: never users, emails, sessions or passwords. Bad or unknown tool calls return an error the model can react to.

### Agent training (admin → Training)

- **Brand rules** and **compliance rules**, for all platforms or just one. Add the brand voice guide as one brand rule titled "Voice guide". Required disclaimers and banned claims work well as separate compliance rules.
- **Example posts per platform**, with optional likes, shares and reach. The best 3 go into every writer prompt.
- **Versions:** editing creates a new version and old versions are kept. You can deactivate, reactivate, or **roll back** to any earlier version, which saves it as a new version. Each version shows which posts used it.
- **Promote to example:** a button on any ready or published social post. **Save engagement** on published posts records likes, shares, reach and saves; top posts are ranked by reach + 10 × shares + 3 × likes.
- The page also shows the **measured AI cost and time** for the last 7 days, and the audit log.

### Sources (admin → Sources)

- Only **https** links. Each one is tagged **Compliance** or **Trends**, and the domains you add form the allowlist.
- **Compliance pages** (regulator guidance, Instagram/LinkedIn/X health-content policies):
  - The server fetches each one right away and then daily, and stores it as a text snapshot.
  - A new or changed page shows its differences and waits for **Approve / Reject**. Until you approve it, the compliance agent keeps using the last approved version.
  - PDF pages aren't supported yet, so add the HTML version.
  - Fetching blocks private and internal addresses, re-checks every redirect against the allowlist, and stops after 2 MB or 15 seconds.
- **Trends sources** set the only domains the trend scout may search or open. Trending keywords are used only where they fit the article's facts.

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
4. Open the service shell and run `npm run create-admin -- you@company.com "Your Name"`.

With every channel in `DRY_RUN_CHANNELS`, the team can use the whole workflow while nothing is posted: items show **Published (Simulated)**. Switch a channel to live by setting its keys and removing it from the list.

Costs during the trial:
- **Claude API:** billed per use. Set a spend limit in the Anthropic Console. The Training page shows the measured cost per article. Estimates:
  - about **$0.60–1.00 per article** (3 posts), and about $2 in the worst case
  - about **$0.15–0.35 for each weekly digest**, and $0 when a week is skipped
  - about 1–2 minutes from approval until the posts are ready
- **Web search:** $10 per 1,000 searches, at most 2 per post. Web fetch costs only tokens.
- **X:** charges per post, but only once X is live.
- **Instagram, LinkedIn, webhook:** free.

Don't use Render's free tier: it wipes the disk (database and images) whenever the app sleeps.

## Connecting the channels

| Channel | What you need |
|---|---|
| **X** | A developer account with pay-per-use credits and an app with "Read and write" permission. Generate the access token and secret for the company account. These keys don't expire. |
| **Instagram** | A professional (business or creator) account and a Meta app with content publishing permission (`instagram_business_content_publish`, or `instagram_content_publish` via Facebook Login). Set `IG_API_BASE`, `IG_USER_ID` and `IG_ACCESS_TOKEN`. Instagram fetches images from `PUBLIC_BASE_URL/media/...`, so the app must be reachable from the internet. |
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

{"id": 12, "title": "...", "slug": "iron-and-energy-12", "html": "<h2>...</h2><p>...</p>", "published_at": "2026-09-25T10:00:00.000Z"}
```

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

- Node built-ins only (`node:http`, `node:sqlite`, `node:crypto`, `fetch`), plus `@anthropic-ai/sdk`.
- Server-rendered HTML forms with no client JavaScript.
- AI uses `claude-opus-5` with tool use (strict schemas), structured JSON output, prompt caching and server-side refusal fallback. No agent framework.
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
| `ai.js` | trend scout, writer and compliance agents |
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

## Known limits

- **Links:** posts don't include the article link automatically. Add it while editing if you want one; on X a link raises the post price.
- **Notifications:** there are none, so people check their dashboard.
- **Scale:** it runs as a single instance, which suits a team tool. Back up `DATA_DIR/app.db` regularly.
