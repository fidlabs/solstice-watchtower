// Configuration from the environment, checked once at start. A service that would send mail from the wrong address, or
// accept alerts with a guessable token, refuses to start instead.

const SEVERITIES = ['info', 'warn', 'critical'];

export function loadConfig(env = process.env) {
  const need = (name) => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const secret = (name) => {
    const v = need(name);
    if (v.length < 32) throw new Error(`${name} must be at least 32 characters (use: openssl rand -hex 32)`);
    return v;
  };

  const publicUrl = need('PUBLIC_URL').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(publicUrl)) throw new Error('PUBLIC_URL must start with https:// (or http:// for local testing)');

  const minSeverity = env.MIN_SEVERITY?.trim() || 'warn';
  if (!SEVERITIES.includes(minSeverity)) throw new Error(`MIN_SEVERITY must be one of ${SEVERITIES.join(', ')}`);

  return {
    port: Number(env.PORT || 8080),
    publicUrl,
    siteName: env.SITE_NAME?.trim() || 'Solstice alerts',
    resendApiKey: need('RESEND_API_KEY'),
    segmentId: need('RESEND_SEGMENT_ID'),
    mailFrom: need('MAIL_FROM'),
    tokenSecret: secret('TOKEN_SECRET'),
    ingestToken: secret('INGEST_TOKEN'),
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    minSeverity,
    // Which request header carries the client address behind the load balancer. DigitalOcean App Platform sets
    // do-connecting-ip; on a droplet behind your own proxy, use x-forwarded-for or x-real-ip.
    clientIpHeader: (env.CLIENT_IP_HEADER || 'do-connecting-ip').toLowerCase(),
  };
}

export { SEVERITIES };
