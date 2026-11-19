// Posts one marked test line to the Slack webhook, to check the secret and the channel. Usage: SLACK_WEBHOOK=... node bin/slack-test.js
const url = process.env.SLACK_WEBHOOK
if (!url) {
  console.error('SLACK_WEBHOOK not set')
  process.exit(1)
}
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    text: `Solstice watchtower: test message from the reader job, ${new Date().toISOString().slice(0, 16)} UTC. Real messages appear here when something lands on chain. https://watchtower.fidl.tech`,
  }),
})
console.log(`slack: ${res.status} ${await res.text()}`)
process.exit(res.ok ? 0 : 1)
