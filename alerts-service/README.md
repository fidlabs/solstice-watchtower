# Alerts service

Email sign-up and alert delivery for one site. Small, no dependencies (Node built-ins only), stateless apart from
in-memory throttling. Subscribers are stored as Resend contacts in one segment.

- **Sign-up** with double opt-in: `GET /` serves the form; `POST /api/subscribe` sends a confirmation link. The link
  opens a page with a button, and only that POST subscribes, so mail scanners that open links cannot subscribe anyone.
  Per-address and per-IP rate limits and a honeypot field keep the form from being used to send mail to strangers.
- **Alerts**: the scheduled jobs `POST /api/alerts` with a bearer token. Each subscriber gets their own email, with an
  unsubscribe link and RFC 8058 one-click headers. Repeats of the same alert are throttled per key: critical at most
  hourly, warn every 6 hours, while escalations go out at once. An `info` only goes out when it resolves an alert
  people already got. Below `MIN_SEVERITY` (default `warn`), nothing is sent.
- **Heartbeats**: jobs `POST /api/heartbeat {name, everySeconds}` on every run. If one goes quiet for three times
  its interval, subscribers get a critical alert. That is the only way to hear about a job that stopped running at
  all (a disabled workflow, a GitHub outage).
- **Never on the critical path.** Senders treat this service as best-effort, and the console, the GitHub issue and
  Slack keep working without it. If the service restarts, it forgets its throttle and heartbeat state: at worst you
  get one repeated alert, and a heartbeat is watched again from its next beat.

## Configuration

| Variable | Example | |
|---|---|---|
| `PUBLIC_URL` | `https://alerts.watchtower.fidl.tech` | Where this service is reachable. Links in emails point here. |
| `SITE_NAME` | `Solstice watchtower alerts` | Shown in emails and on the pages. |
| `RESEND_API_KEY` | `re_…` | A Resend key with sending and contacts access. |
| `RESEND_SEGMENT_ID` | `…` | The segment that holds this site's subscribers. Use one segment per site. |
| `MAIL_FROM` | `Solstice watchtower <alerts@fidl.tech>` | Must be on a domain verified in Resend (SPF/DKIM). |
| `TOKEN_SECRET` | `openssl rand -hex 32` | Signs confirm/unsubscribe links. Changing it voids every outstanding link. |
| `INGEST_TOKEN` | `openssl rand -hex 32` | The bearer token the jobs use. Also store it as the repo secret `ALERT_SERVICE_TOKEN`. |
| `ALLOWED_ORIGINS` | `https://watchtower.fidl.tech` | Pages allowed to post the sign-up form from the browser. |
| `MIN_SEVERITY` | `warn` | `info`, `warn` or `critical`. |
| `CLIENT_IP_HEADER` | `do-connecting-ip` | The header carrying the client address behind the load balancer. The default is App Platform's; on a droplet behind your own proxy, use `x-forwarded-for`. |

## Deploy on DigitalOcean App Platform

1. In Resend, verify the sending domain (`fidl.tech`, or a subdomain), create a segment for this site, and create
   an API key.
2. Create an App from this repository, with source directory `alerts-service/` (the Dockerfile is detected). HTTP
   port 8080, health check `/healthz`. One instance: the throttle and heartbeats are in memory.
3. Set the variables above, with secrets as encrypted values. Add the domain (e.g. `alerts.watchtower.fidl.tech`) and
   set `PUBLIC_URL` to it.
4. In the GitHub repository, set the variable `ALERT_SERVICE_URL` to the same URL and the secret
   `ALERT_SERVICE_TOKEN` to `INGEST_TOKEN`.
5. Check: open `PUBLIC_URL`, subscribe, confirm, then send yourself a test alert:
   `curl -X POST "$PUBLIC_URL/api/alerts" -H "authorization: Bearer $INGEST_TOKEN" -H 'content-type: application/json' -d '{"key":"test","severity":"warn","title":"test alert"}'`

On a droplet, `docker build -t alerts . && docker run -d --restart=always -p 8080:8080 --env-file .env alerts` behind
a TLS proxy. Set `CLIENT_IP_HEADER` to whatever your proxy sends.

## Develop

`npm test` runs everything against a fake Resend client; nothing is sent.
