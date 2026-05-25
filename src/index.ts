import dns from 'node:dns';
import { startServer } from './server/index.js';

// Some networks hand out IPv6 (AAAA) DNS records but have no working IPv6
// route. Node's fetch/undici then attempts IPv6 first and hangs until it times
// out, surfacing as a generic "fetch failed" on every Spotify call. Preferring
// IPv4 makes outbound requests connect reliably; it's a no-op where IPv6 works.
dns.setDefaultResultOrder('ipv4first');

startServer();
