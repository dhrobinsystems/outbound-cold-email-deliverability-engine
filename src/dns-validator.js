#!/usr/bin/env node
'use strict';

/**
 * dns-validator.js
 * Part of: outbound-cold-email-deliverability-engine
 *
 * Standalone module + CLI for validating outbound email infrastructure.
 *
 *   - Sender infrastructure: SPF, DKIM, DMARC, MX, and domain/IP blacklist (DNSBL) checks,
 *     rolled into a 0-100 health score and a campaign gate (PASS | WARN | UNVERIFIED | HOLD).
 *   - Lead domains: MX validity (NXDOMAIN, no MX, null MX, unresolvable MX hosts).
 *
 * Two resolver back-ends, selectable per call or via the CLI:
 *   - "system": the operating system / Node.js resolver (optionally pinned to specific servers).
 *   - "doh":    DNS-over-HTTPS using the JSON API (Google, Cloudflare, or your own endpoint).
 *
 * Requirements: Node.js 18+ (uses the built-in fetch for DoH). Zero dependencies.
 *
 * Scoring weights are identical to the n8n workflow in this repository:
 *   SPF 25 (15 present + 5 strict -all/~all + 5 lookups <= 10), DKIM 25,
 *   DMARC 25 (reject 25, quarantine 22, none 10, -3 if pct < 100), MX 10,
 *   blacklist 15 (clear 15, inconclusive 8, listed 0).
 *
 * Environment variables (all optional):
 *   DNS_MODE, DNS_DOH_ENDPOINT, DNS_DOH_API_KEY, DKIM_SELECTORS,
 *   DNSBL_DOMAIN_ZONES, DNSBL_IP_ZONES, SENDER_MIN_SCORE
 */

const dnsPromises = require('node:dns').promises;
const net = require('node:net');

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

const DEFAULT_SELECTORS = ['google', 'selector1', 'selector2', 'default', 'k1', 'k2', 's1', 's2', 'mail', 'dkim'];
const DEFAULT_DNSBL_DOMAIN_ZONES = ['dbl.spamhaus.org', 'multi.surbl.org', 'multi.uribl.com'];
const DEFAULT_DNSBL_IP_ZONES = ['zen.spamhaus.org', 'bl.spamcop.net'];
const DEFAULT_DOH_ENDPOINT = 'https://dns.google/resolve';
const RR_TYPES = { A: 1, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
const DOMAIN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const csv = (value, fallback) => {
  const list = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : fallback;
};

const stripTrailingDot = (host) => String(host).trim().replace(/\.$/, '').toLowerCase();

const normalizeDomain = (value) => stripTrailingDot(String(value || '').trim());

const isValidDomain = (domain) => DOMAIN_PATTERN.test(domain);

const gradeFor = (score) => (score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F');

async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolver layer
//
// Every resolver exposes txt(name), mx(name), a(name), aaaa(name), each returning a normalized result:
//   { ok, missing, nxdomain, code, data }
//   ok       - records were returned (data is populated)
//   missing  - the name or record type definitively does not exist (NXDOMAIN or NODATA)
//   nxdomain - the name itself does not exist
//   code     - 'OK', 'NXDOMAIN', 'NODATA', or an error code (TIMEOUT, HTTP_503, RCODE_2, ...)
// When both ok and missing are false, the lookup failed and the answer is unknown.
// ---------------------------------------------------------------------------

const found = (data) => ({ ok: true, missing: false, nxdomain: false, code: 'OK', data });
const absent = (code, nxdomain = false) => ({ ok: false, missing: true, nxdomain, code, data: [] });
const failure = (code) => ({ ok: false, missing: false, nxdomain: false, code, data: [] });

const memoize = (cache, key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};

/** Resolver backed by the Node.js / operating system DNS stack. */
function createSystemResolver(options = {}) {
  const cache = new Map();
  let client = dnsPromises;
  if (options.servers && options.servers.length) {
    client = new dnsPromises.Resolver();
    client.setServers(options.servers);
  }

  const run = async (fn) => {
    try {
      return found(await fn());
    } catch (err) {
      if (err.code === 'ENOTFOUND') return absent('NXDOMAIN', true);
      if (err.code === 'ENODATA') return absent('NODATA');
      return failure(err.code || 'ERROR');
    }
  };

  return {
    mode: 'system',
    txt: (name) => memoize(cache, `TXT:${name}`, async () => {
      const res = await run(() => client.resolveTxt(name));
      return res.ok ? found(res.data.map((chunks) => chunks.join(''))) : res;
    }),
    mx: (name) => memoize(cache, `MX:${name}`, async () => {
      const res = await run(() => client.resolveMx(name));
      return res.ok ? found(res.data.map((m) => ({ priority: m.priority, exchange: stripTrailingDot(m.exchange) }))) : res;
    }),
    a: (name) => memoize(cache, `A:${name}`, () => run(() => client.resolve4(name))),
    aaaa: (name) => memoize(cache, `AAAA:${name}`, () => run(() => client.resolve6(name)))
  };
}

/** Resolver backed by a DNS-over-HTTPS JSON endpoint (RFC 8484 JSON flavor used by Google and Cloudflare). */
function createDohResolver(options = {}) {
  const endpoint = options.endpoint || DEFAULT_DOH_ENDPOINT;
  const timeoutMs = options.timeoutMs || 8000;
  const retries = options.retries === undefined ? 2 : options.retries;
  const headers = { accept: 'application/dns-json' };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  const cache = new Map();

  const query = async (name, type) => {
    let lastCode = 'ERROR';
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(200 * attempt);
      try {
        const url = new URL(endpoint);
        url.searchParams.set('name', name);
        url.searchParams.set('type', type);
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
          lastCode = `HTTP_${res.status}`;
          continue;
        }
        const body = await res.json();
        if (body.Status === 3) return absent('NXDOMAIN', true);
        if (body.Status !== 0) {
          lastCode = `RCODE_${body.Status}`;
          continue;
        }
        const answers = (body.Answer || []).filter((a) => a.type === RR_TYPES[type]).map((a) => String(a.data));
        return answers.length ? found(answers) : absent('NODATA');
      } catch (err) {
        lastCode = err.name === 'TimeoutError' ? 'TIMEOUT' : (err.code || err.name || 'ERROR');
      }
    }
    return failure(lastCode);
  };

  const joinTxt = (data) => String(data).split('" "').join('').split('"').join('');

  return {
    mode: 'doh',
    endpoint,
    txt: (name) => memoize(cache, `TXT:${name}`, async () => {
      const res = await query(name, 'TXT');
      return res.ok ? found(res.data.map(joinTxt)) : res;
    }),
    mx: (name) => memoize(cache, `MX:${name}`, async () => {
      const res = await query(name, 'MX');
      if (!res.ok) return res;
      return found(res.data.map((record) => {
        const parts = record.trim().split(' ');
        return { priority: Number(parts[0]), exchange: stripTrailingDot(parts[1] || '') };
      }));
    }),
    a: (name) => memoize(cache, `A:${name}`, () => query(name, 'A')),
    aaaa: (name) => memoize(cache, `AAAA:${name}`, () => query(name, 'AAAA'))
  };
}

/**
 * Build a resolver.
 * @param {object} [options]
 * @param {'system'|'doh'} [options.mode]   Defaults to DNS_MODE, then 'system'.
 * @param {string}   [options.endpoint]     DoH endpoint (default DNS_DOH_ENDPOINT, then Google).
 * @param {string}   [options.apiKey]       DoH bearer token (default DNS_DOH_API_KEY).
 * @param {string[]} [options.servers]      System mode: pin lookups to these DNS servers.
 * @param {number}   [options.timeoutMs]    DoH per-request timeout.
 * @param {number}   [options.retries]      DoH retries per query.
 */
function createResolver(options = {}) {
  const mode = String(options.mode || process.env.DNS_MODE || 'system').toLowerCase();
  if (mode === 'doh') {
    return createDohResolver({
      endpoint: options.endpoint || process.env.DNS_DOH_ENDPOINT || DEFAULT_DOH_ENDPOINT,
      apiKey: options.apiKey || process.env.DNS_DOH_API_KEY,
      timeoutMs: options.timeoutMs,
      retries: options.retries
    });
  }
  if (mode === 'system') return createSystemResolver(options);
  throw new Error(`Unknown DNS mode "${mode}". Use "system" or "doh".`);
}

const resolverFrom = (options = {}) => options.resolver || createResolver(options);

// ---------------------------------------------------------------------------
// Record parsers (pure functions, unit-testable without network access)
// ---------------------------------------------------------------------------

function parseSpf(records) {
  const spfRecords = records.filter((r) => r.toLowerCase().startsWith('v=spf1'));
  const out = { present: spfRecords.length > 0, multiple: spfRecords.length > 1, record: spfRecords[0] || '', all: '', lookups: 0, points: 0, issues: [] };
  if (!out.present) {
    out.issues.push('SPF record missing');
    return out;
  }
  const parts = out.record.toLowerCase().split(' ').filter(Boolean);
  out.all = parts.find((p) => ['-all', '~all', '?all', '+all', 'all'].includes(p)) || '';
  out.lookups = parts.filter((p) => p.startsWith('include:') || p.startsWith('redirect=') || p.startsWith('exists:') ||
    p === 'a' || p.startsWith('a:') || p.startsWith('a/') || p === 'mx' || p.startsWith('mx:') || p.startsWith('mx/') || p.startsWith('ptr')).length;
  if (out.multiple) out.issues.push('Multiple SPF records published (permerror)');
  else out.points += 15;
  if (out.all === '-all' || out.all === '~all') out.points += 5;
  else out.issues.push(`SPF terminal mechanism is weak or missing (${out.all || 'none'})`);
  if (out.lookups <= 10) out.points += 5;
  else out.issues.push(`SPF exceeds 10 DNS lookups (${out.lookups} top-level)`);
  return out;
}

function parseDmarc(records) {
  const matches = records.filter((r) => r.toLowerCase().startsWith('v=dmarc1'));
  const tags = {};
  if (matches[0]) {
    matches[0].split(';').forEach((kv) => {
      const i = kv.indexOf('=');
      if (i > 0) tags[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
    });
  }
  const out = { present: matches.length > 0, policy: (tags.p || '').toLowerCase(), pct: tags.pct ? Number(tags.pct) : 100, rua: tags.rua || '', points: 0, issues: [] };
  if (!out.present) {
    out.issues.push('DMARC record missing');
    return out;
  }
  if (out.policy === 'reject') out.points += 25;
  else if (out.policy === 'quarantine') out.points += 22;
  else if (out.policy === 'none') {
    out.points += 10;
    out.issues.push('DMARC policy is p=none (monitoring only)');
  } else {
    out.issues.push('DMARC policy tag invalid or missing');
  }
  if (out.pct < 100) {
    out.points -= 3;
    out.issues.push('DMARC pct is below 100');
  }
  if (!out.rua) out.issues.push('DMARC has no rua reporting address');
  return out;
}

/** @param {{selector: string, records: string[]}[]} results */
function parseDkim(results, selectors) {
  const keys = results.map(({ selector, records }) => {
    const rec = records.find((t) => t.toLowerCase().includes('v=dkim1') || t.toLowerCase().includes('p='));
    if (!rec) return null;
    const tag = rec.split(';').map((x) => x.trim()).find((x) => x.toLowerCase().startsWith('p='));
    return { selector, revoked: !tag || tag.slice(2).trim() === '' };
  }).filter(Boolean);
  const valid = keys.filter((k) => !k.revoked).map((k) => k.selector);
  const issues = [];
  if (!valid.length) issues.push(`No active DKIM key at tested selectors (${selectors.join(', ')})`);
  if (keys.some((k) => k.revoked)) issues.push(`Revoked DKIM key at selector(s): ${keys.filter((k) => k.revoked).map((k) => k.selector).join(', ')}`);
  return { tested: selectors, valid_selectors: valid, found: keys, points: valid.length ? 25 : 0, issues };
}

/**
 * Several DNSBL operators answer 127.255.255.x (or URIBL answers 127.0.0.1) to say "query refused",
 * typically because the lookup came from a public resolver. That is not a listing.
 */
function isBlockedDnsblAnswer(zone, code) {
  return code.startsWith('127.255.255.') || (zone.includes('uribl') && code === '127.0.0.1');
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Validate a domain's mail routing: MX exists, is not a null MX, and at least one of the
 * top three MX hosts resolves to an address.
 * mx_valid: true (ok) | false (definitively broken) | null (lookup failed, unknown).
 */
async function checkMx(domain, options = {}) {
  const resolver = resolverFrom(options);
  const res = await resolver.mx(domain);
  if (!res.ok) {
    if (res.nxdomain) return { domain, mx_valid: false, reason: 'nxdomain', hosts: [] };
    if (res.missing) return { domain, mx_valid: false, reason: 'no_mx_records', hosts: [] };
    return { domain, mx_valid: null, reason: 'dns_lookup_failed', hosts: [] };
  }
  const real = res.data.filter((m) => m.exchange).sort((a, b) => a.priority - b.priority).slice(0, 3);
  if (!real.length) return { domain, mx_valid: false, reason: 'null_mx', hosts: [] };
  const hosts = await Promise.all(real.map(async (m) => {
    const [a, aaaa] = await Promise.all([resolver.a(m.exchange), resolver.aaaa(m.exchange)]);
    return {
      priority: m.priority,
      host: m.exchange,
      resolves: a.ok || aaaa.ok,
      lookup_ok: (a.ok || a.missing) && (aaaa.ok || aaaa.missing)
    };
  }));
  const anyResolves = hosts.some((h) => h.resolves);
  const anyUnknown = hosts.some((h) => !h.lookup_ok);
  return {
    domain,
    mx_valid: anyResolves ? true : (anyUnknown ? null : false),
    reason: anyResolves ? 'ok' : (anyUnknown ? 'dns_lookup_failed' : 'mx_hosts_unresolvable'),
    hosts
  };
}

async function lookupDnsbl(name, zone, resolver) {
  const res = await resolver.a(`${name}.${zone}`);
  if (res.ok) {
    const blocked = res.data.some((code) => isBlockedDnsblAnswer(zone, code));
    return { zone, listed: !blocked, inconclusive: blocked, codes: res.data };
  }
  return { zone, listed: false, inconclusive: !res.missing, codes: [] };
}

/** Check a domain against domain-based DNSBLs. status: 'listed' | 'clear' | 'inconclusive'. */
async function checkBlacklist(domain, options = {}) {
  const opts = Array.isArray(options) ? { zones: options } : options;
  const resolver = resolverFrom(opts);
  const zones = opts.zones || csv(process.env.DNSBL_DOMAIN_ZONES, DEFAULT_DNSBL_DOMAIN_ZONES);
  const checks = await Promise.all(zones.map((zone) => lookupDnsbl(domain, zone, resolver)));
  const listedOn = checks.filter((c) => c.listed).map((c) => c.zone);
  const status = listedOn.length ? 'listed' : (checks.every((c) => c.inconclusive) ? 'inconclusive' : 'clear');
  return { status, listed_on: listedOn, checks };
}

/** Check an IPv4 address against IP-based DNSBLs. IPv6 is not supported. */
async function checkIp(ip, options = {}) {
  if (!net.isIPv4(ip)) return { ip, valid: false, listed_on: [], inconclusive: false, checks: [] };
  const resolver = resolverFrom(options);
  const zones = options.ipZones || csv(process.env.DNSBL_IP_ZONES, DEFAULT_DNSBL_IP_ZONES);
  const reversed = ip.split('.').reverse().join('.');
  const checks = await Promise.all(zones.map((zone) => lookupDnsbl(reversed, zone, resolver)));
  return {
    ip,
    valid: true,
    listed_on: checks.filter((c) => c.listed).map((c) => c.zone),
    inconclusive: checks.every((c) => c.inconclusive),
    checks
  };
}

// ---------------------------------------------------------------------------
// Sender infrastructure
// ---------------------------------------------------------------------------

/**
 * Audit one sending domain: SPF, DKIM, DMARC, MX, blacklist, rolled into a 0-100 score.
 * @param {string} domain
 * @param {object} [options] resolver, selectors, zones, plus createResolver() options.
 */
async function validateDomain(domain, options = {}) {
  const resolver = resolverFrom(options);
  const selectors = options.selectors || csv(process.env.DKIM_SELECTORS, DEFAULT_SELECTORS);
  const [mx, spfRes, dmarcRes, dkimRes, blacklist] = await Promise.all([
    checkMx(domain, { resolver }),
    resolver.txt(domain),
    resolver.txt(`_dmarc.${domain}`),
    Promise.all(selectors.map(async (selector) => ({ selector, records: (await resolver.txt(`${selector}._domainkey.${domain}`)).data }))),
    checkBlacklist(domain, { resolver, zones: options.zones })
  ]);
  const spf = parseSpf(spfRes.data);
  const dmarc = parseDmarc(dmarcRes.data);
  const dkim = parseDkim(dkimRes, selectors);
  const issues = [...spf.issues, ...dkim.issues, ...dmarc.issues];
  let score = spf.points + dkim.points + dmarc.points;
  if (mx.mx_valid === true) score += 10;
  else issues.push(`Sending domain MX invalid or unverifiable (${mx.reason})`);
  if (blacklist.status === 'listed') issues.push(`CRITICAL: domain listed on ${blacklist.listed_on.join(', ')}`);
  else if (blacklist.status === 'inconclusive') issues.push('Blacklist lookups inconclusive (resolver blocked or failed) - use a private resolver');
  score += blacklist.status === 'clear' ? 15 : (blacklist.status === 'inconclusive' ? 8 : 0);
  score = Math.max(0, Math.min(100, score));
  return { domain, score, grade: gradeFor(score), mx, spf, dkim, dmarc, blacklist, issues };
}

/**
 * Audit sender domains and IPs and compute the campaign gate.
 * Gate: HOLD (any listing, or score < minScore) > WARN (issues present) > PASS.
 * With nothing to audit: UNVERIFIED, or HOLD when options.requireAudit is true.
 * @param {{domains?: string[], ips?: string[]}} targets
 * @param {object} [options] minScore (default SENDER_MIN_SCORE or 70), requireAudit, plus validateDomain options.
 */
async function auditSenderInfrastructure(targets = {}, options = {}) {
  const domains = (targets.domains || []).map(normalizeDomain).filter(Boolean);
  const ips = targets.ips || [];
  const resolver = resolverFrom(options);
  const opts = { ...options, resolver };
  const minScore = options.minScore !== undefined ? Number(options.minScore) : Number(process.env.SENDER_MIN_SCORE || 70);

  const domainAudits = await mapLimit(domains, 5, (domain) => validateDomain(domain, opts));
  const ipAudits = await mapLimit(ips, 5, (ip) => checkIp(ip, opts));

  let gate = 'PASS';
  const reasons = [];
  if (!domainAudits.length && !ipAudits.length) {
    if (options.requireAudit) {
      gate = 'HOLD';
      reasons.push('No sending domains supplied and an audit is required');
    } else {
      gate = 'UNVERIFIED';
      reasons.push('No sending domains supplied; sender audit skipped');
    }
  }
  domainAudits.forEach((d) => {
    if (d.blacklist.status === 'listed') {
      gate = 'HOLD';
      reasons.push(`${d.domain} is blacklisted on ${d.blacklist.listed_on.join(', ')}`);
    } else if (d.score < minScore) {
      gate = 'HOLD';
      reasons.push(`${d.domain} health score ${d.score} is below minimum ${minScore}`);
    } else if (d.issues.length && gate === 'PASS') {
      gate = 'WARN';
    }
  });
  ipAudits.forEach((i) => {
    if (!i.valid) {
      reasons.push(`Invalid sending IP ignored: ${i.ip}`);
    } else if (i.listed_on.length) {
      gate = 'HOLD';
      reasons.push(`${i.ip} is blacklisted on ${i.listed_on.join(', ')}`);
    }
  });

  return { gate, reasons, min_score: minScore, resolver_mode: resolver.mode, audited_at: new Date().toISOString(), domains: domainAudits, ips: ipAudits };
}

// ---------------------------------------------------------------------------
// Lead domains
// ---------------------------------------------------------------------------

/**
 * Validate a lead's email address or bare domain for mail routing.
 * reject_reason mirrors the n8n workflow: missing_domain, invalid_syntax, dns_nxdomain,
 * dns_no_mx_records, dns_null_mx, dns_mx_hosts_unresolvable (empty string when acceptable or unknown).
 */
async function validateLead(input, options = {}) {
  const raw = String(input || '').trim().toLowerCase();
  const at = raw.lastIndexOf('@');
  const domain = normalizeDomain(at >= 0 ? raw.slice(at + 1) : raw);
  const base = { input: String(input || ''), domain };
  if (!domain) return { ...base, syntax_valid: false, mx_valid: false, reject_reason: 'missing_domain', mx: null };
  const multipleAt = at >= 0 && raw.indexOf('@') !== at;
  if (multipleAt || !isValidDomain(domain)) return { ...base, syntax_valid: false, mx_valid: false, reject_reason: 'invalid_syntax', mx: null };
  const mx = await checkMx(domain, options);
  return { ...base, syntax_valid: true, mx_valid: mx.mx_valid, reject_reason: mx.mx_valid === false ? `dns_${mx.reason}` : '', mx };
}

/** Validate many leads with one shared resolver, so each unique domain is looked up once. */
async function validateLeads(inputs, options = {}) {
  const opts = { ...options, resolver: resolverFrom(options) };
  return mapLimit(inputs, 10, (input) => validateLead(input, opts));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

class UsageError extends Error {}

const USAGE = `Usage:
  node dns-validator.js <sender-domain> [sender-domain...] [options]     Audit sender infrastructure
  node dns-validator.js --lead <email|domain> [email|domain...] [options] Validate lead MX records

Options:
  --mode <system|doh>      DNS back-end (default: DNS_MODE or system)
  --doh-endpoint <url>     DoH JSON endpoint (default: DNS_DOH_ENDPOINT or https://dns.google/resolve)
  --servers <ip,ip>        System mode: pin lookups to these DNS servers
  --selectors <a,b>        DKIM selectors to test (default: DKIM_SELECTORS or a common set)
  --zones <a,b>            Domain DNSBL zones (default: DNSBL_DOMAIN_ZONES)
  --ip <ip,ip>             Sender IPv4 addresses to check against IP DNSBLs
  --min-score <n>          Health score below which the gate is HOLD (default: SENDER_MIN_SCORE or 70)
  --format <json|text>     Output format (default: json)
  --lead                   Treat arguments as lead emails/domains and validate MX only
  --help                   Show this help

Environment: DNS_DOH_API_KEY supplies a bearer token for DoH endpoints that require one.

Exit codes: 0 pass (PASS, WARN, UNVERIFIED, or lead MX ok/unknown), 1 fail (HOLD or lead MX broken), 2 usage or runtime error.`;

function parseCliArgs(argv) {
  const valued = new Set(['mode', 'doh-endpoint', 'servers', 'selectors', 'zones', 'ip', 'min-score', 'format']);
  const switches = new Set(['lead', 'help']);
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    if (valued.has(key)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new UsageError(`Missing value for --${key}`);
      flags[key] = value;
    } else if (switches.has(key)) {
      flags[key] = true;
    } else {
      throw new UsageError(`Unknown option: --${key}`);
    }
  }
  return { positionals, flags };
}

function formatSenderText(report) {
  const lines = [`Sender gate: ${report.gate} (resolver: ${report.resolver_mode})`];
  report.reasons.forEach((reason) => lines.push(`  - ${reason}`));
  report.domains.forEach((d) => {
    lines.push('', `${d.domain}  score ${d.score}/100 (${d.grade})  blacklist: ${d.blacklist.status}`);
    lines.push(`  SPF: ${d.spf.present ? (d.spf.all || 'present') : 'missing'} | DKIM: ${d.dkim.valid_selectors.join(',') || 'none'} | DMARC: ${d.dmarc.present ? `p=${d.dmarc.policy}` : 'missing'} | MX: ${d.mx.mx_valid}`);
    d.issues.forEach((issue) => lines.push(`  ! ${issue}`));
  });
  report.ips.forEach((ip) => {
    const status = !ip.valid ? 'invalid IPv4 address' : (ip.listed_on.length ? `LISTED on ${ip.listed_on.join(', ')}` : `not listed${ip.inconclusive ? ' (inconclusive)' : ''}`);
    lines.push('', `${ip.ip}  ${status}`);
  });
  return lines.join('\n');
}

function formatLeadText(results) {
  return results.map((r) => {
    const verdict = r.mx_valid === true ? 'OK' : (r.mx_valid === false ? `REJECT (${r.reject_reason})` : 'UNKNOWN (DNS lookup failed)');
    return `${r.input || '(empty)'}  ->  ${verdict}`;
  }).join('\n');
}

async function main(argv) {
  const { positionals, flags } = parseCliArgs(argv);
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  if (!positionals.length) throw new UsageError('No domains or leads supplied.');

  const format = flags.format || 'json';
  if (!['json', 'text'].includes(format)) throw new UsageError('--format must be "json" or "text"');

  const resolver = createResolver({
    mode: flags.mode,
    endpoint: flags['doh-endpoint'],
    servers: flags.servers ? csv(flags.servers, []) : undefined
  });

  if (flags.lead) {
    const results = await validateLeads(positionals, { resolver });
    console.log(format === 'json' ? JSON.stringify(results, null, 2) : formatLeadText(results));
    return results.some((r) => r.mx_valid === false) ? 1 : 0;
  }

  const domains = positionals.map(normalizeDomain);
  const invalid = domains.filter((d) => !isValidDomain(d));
  if (invalid.length) throw new UsageError(`Invalid sender domain(s): ${invalid.join(', ')}`);

  const minScore = Number(flags['min-score'] !== undefined ? flags['min-score'] : (process.env.SENDER_MIN_SCORE || 70));
  if (Number.isNaN(minScore)) throw new UsageError('--min-score must be a number');

  const report = await auditSenderInfrastructure(
    { domains, ips: csv(flags.ip, []) },
    {
      resolver,
      minScore,
      selectors: flags.selectors ? csv(flags.selectors, DEFAULT_SELECTORS) : undefined,
      zones: flags.zones ? csv(flags.zones, DEFAULT_DNSBL_DOMAIN_ZONES) : undefined
    }
  );
  console.log(format === 'json' ? JSON.stringify(report, null, 2) : formatSenderText(report));
  return report.gate === 'HOLD' ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      if (err instanceof UsageError) {
        console.error(`${err.message}\n\n${USAGE}`);
      } else {
        console.error(`dns-validator error: ${err.message}`);
      }
      process.exitCode = 2;
    }
  );
}

module.exports = {
  // Resolvers
  createResolver,
  createSystemResolver,
  createDohResolver,
  // Lookups
  checkMx,
  checkBlacklist,
  checkIp,
  // Sender infrastructure
  validateDomain,
  auditSenderInfrastructure,
  // Lead domains
  validateLead,
  validateLeads,
  // Pure helpers
  parseSpf,
  parseDmarc,
  parseDkim,
  isBlockedDnsblAnswer,
  isValidDomain,
  normalizeDomain,
  gradeFor
};
