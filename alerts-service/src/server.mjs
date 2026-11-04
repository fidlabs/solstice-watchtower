#!/usr/bin/env node
import { createServer } from 'node:http';
import { createApp } from './app.mjs';
import { loadConfig } from './config.mjs';
import { createResend } from './resend.mjs';

const config = loadConfig();
const app = createApp({ config, resend: createResend({ apiKey: config.resendApiKey }) });
const server = createServer(app.handler);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(config.port, () => console.log(`${config.siteName}: listening on :${config.port}, links point at ${config.publicUrl}`));
const timer = setInterval(() => app.checkHeartbeats(), 60_000);
const stop = () => { clearInterval(timer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5_000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
