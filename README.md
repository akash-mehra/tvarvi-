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
- **Claude API:** billed per use. Set a spend limit in the Anthropic Console.
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
- AI uses `claude-opus-5` with structured JSON output and server-side refusal fallback.
- Security:
  - scrypt password hashing and 12-hour sessions.
  - Login lockout after 5 failures.
  - Same-origin checks on every form post and a strict Content-Security-Policy.
  - Every workflow step is a guarded state change, so double clicks can't publish twice.

| File | Purpose |
|---|---|
| `server.js` | routes, auth, workflow rules |
| `ai.js` | writer and compliance agents |
| `publish.js` | website, Instagram, LinkedIn and X |
| `views.js` | pages |
| `text.js` | text helpers |
| `db.js` | schema |

```sh
npm test
```

## Known limits

- **Links:** posts don't include the article link automatically. Add it while editing if you want one; on X a link raises the post price.
- **Notifications:** there are none, so people check their dashboard.
- **Scale:** it runs as a single instance, which suits a team tool. Back up `DATA_DIR/app.db` regularly.
