# Infra Status Dashboard

A one-file status board for the stack your lead-magnets run on: **Netlify** (hosting), **Supabase** (backend/DB), **Resend** (email). Pulls what each platform's API exposes live, fills the rest (plan cost, quotas) from a config you control, and bakes a self-contained `dashboard.html` you can double-click or host.

## Setup (once)

```bash
cd dashboard
cp .env.example .env            # paste your read-only API tokens
cp config.example.json config.json   # set plan name, monthly cost, limits
```

### Getting each token (read-only is enough)

| Platform | Where | Token type |
|----------|-------|-----------|
| **Netlify** | app.netlify.com → User settings → Applications → Personal access tokens | Personal access token |
| **Supabase** | supabase.com/dashboard → Account → Access Tokens | **Management API** token (not a project anon/service key) |
| **Resend** | resend.com/api-keys → Create API Key | API key (Sending/Read access) |

Leave any token blank to skip that platform.

## Refresh

```bash
node sync.mjs
```

Re-reads `.env` + `config.json`, re-queries the three APIs, rewrites `dashboard.html`. Open that file in any browser.

## What's live vs. config-driven

| Metric | Source |
|--------|--------|
| Netlify: sites, deploy state, bandwidth used | **Live API** |
| Supabase: projects, health status, region | **Live API** |
| Resend: domains, verification status, API keys | **Live API** |
| Plan name + monthly $ cost (all three) | `config.json` — no billing API at these tiers |
| Supabase DB size / egress / MAU quotas | `config.json` — not in Management API |
| Resend sends this month | `config.json` (`sentThisMonth`) — no usage API |

## Auto-refresh (optional)

It's a static snapshot — it doesn't update itself. To refresh every morning, add a cron entry:

```bash
# crontab -e  → run at 8am daily
0 8 * * * cd "/full/path/to/dashboard" && /usr/bin/node sync.mjs
```

## Security

`.env` holds live tokens — it is git-ignored by intent. Never commit it. Use read-only scopes wherever the platform allows.
