import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import axios, { AxiosError } from 'axios';

// ---------- You usually only change these ----------
const DEFAULT_QUOTE = 'ADA';
const DEFAULT_INTERVAL = '4h';
const DEFAULT_DAYS = 30;
const DEFAULT_OUTDIR = path.resolve('data');
// ---------------------------------------------------

// Known base + candidate endpoint paths (we'll probe in order)
const API_BASE = 'https://openapi.taptools.io';
const CANDIDATE_PATHS = [
    '/api/v1/token/ohlcv',
    '/api/v1/tokens/ohlcv',
    '/api/v1/market/ohlcv',
    '/api/v1/markets/ohlcv',
    '/api/v1/price/ohlcv',
    '/api/v1/ohlcv',
]; // we’ll stop at the first 2xx response

type Args = Record<string, string | boolean>;
function parseArgs(): Args {
    const out: Args = {};
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        if (!tok.startsWith('--')) continue;
        if (tok.includes('=')) {
            const [k, ...rest] = tok.slice(2).split('=');
            out[k] = rest.join('=');
        } else {
            const k = tok.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) { out[k] = next; i++; }
            else out[k] = true;
        }
    }
    return out;
}

function isoFromDaysAgo(days: number) {
    const ms = Date.now() - days * 86400_000;
    return new Date(ms).toISOString();
}

function ensureDir(p: string) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function outCsvPath(token: string, quote: string, interval: string, outdir: string) {
    return path.join(outdir, `candles_${token.toLowerCase()}_${quote.toLowerCase()}_${interval}.csv`);
}

// Accept common key variants
type RawCandle = Record<string, any>;
function normalizeCandles(arr: RawCandle[]) {
    return arr.map((c) => {
        const t = c.time ?? c.timestamp ?? c.t;
        const o = c.open ?? c.o;
        const h = c.high ?? c.h;
        const l = c.low ?? c.l;
        const cl = c.close ?? c.c;
        const v = c.volume ?? c.v ?? '';
        if (t == null || o == null || h == null || l == null || cl == null) return null;
        const iso = typeof t === 'number' ? new Date(t * 1000).toISOString()
            : new Date(t).toISOString();
        return { iso, o, h, l, cl, v };
    }).filter(Boolean) as { iso: string; o: number; h: number; l: number; cl: number; v: number | string; }[];
}

async function tryEndpoint(pathname: string, params: Record<string, string>) {
    try {
        const { data, status } = await axios.get(`${API_BASE}${pathname}`, {
            headers: { 'x-api-key': process.env.TAPTOOLS_API_KEY! },
            params,
            timeout: 60_000,
        });
        if (status >= 200 && status < 300 && Array.isArray(data) && data.length) {
            const norm = normalizeCandles(data);
            if (norm.length) return { pathname, data: norm };
        }
        return null;
    } catch (e) {
        const ax = e as AxiosError;
        // If 404, just move on; if 401/403 or other, print once for debugging.
        if (ax.response && ax.response.status !== 404) {
            console.error(`[${pathname}] ${ax.response.status} ${JSON.stringify(ax.response.data)}`);
        }
        return null;
    }
}

async function main() {
    const a = parseArgs();

    const token = (a.token as string) || process.env.TOKEN_NAME;
    if (!token) throw new Error('Missing --token <TICKER> (e.g., CRAWJU) or TOKEN_NAME env.');
    const unit = (a.unit as string) || process.env.UNIT;
    if (!unit) throw new Error(`Missing UNIT for ${token}. Pass --unit <policyId+assetNameHex> or set UNIT env.`);
    const apiKey = process.env.TAPTOOLS_API_KEY;
    if (!apiKey) throw new Error('Missing TAPTOOLS_API_KEY env.');

    const quote = (a.quote as string) || DEFAULT_QUOTE;
    const interval = (a.interval as string) || DEFAULT_INTERVAL;
    const outdir = path.resolve((a.outdir as string) || DEFAULT_OUTDIR);
    ensureDir(outdir);

    let start = (a.start as string) || undefined;
    let end = (a.end as string) || undefined;
    const days = a.days ? Number(a.days) : DEFAULT_DAYS;
    if (!start) start = isoFromDaysAgo(days);
    if (!end) end = new Date().toISOString();

    // Probe candidate endpoints until one works
    const params = { unit, quote, interval, start, end };
    let found: { pathname: string; data: ReturnType<typeof normalizeCandles> } | null = null;

    for (const p of CANDIDATE_PATHS) {
        const res = await tryEndpoint(p, params);
        if (res) { found = res; break; }
    }

    if (!found) {
        throw new Error(
            'Could not find a working OHLCV endpoint (got 404 on candidates).\n' +
            'Check your plan & docs in the TapTools OpenAPI UI and adjust CANDIDATE_PATHS.'
        );
    }

    const out = outCsvPath(token, quote, interval, outdir);
    const rows = ['timestamp_utc,open,high,low,close,volume'];
    for (const c of found.data) rows.push([c.iso, c.o, c.h, c.l, c.cl, c.v].join(','));
    fs.writeFileSync(out, rows.join('\n'));

    console.log(`Saved: ${out}`);
    console.log(`Used endpoint: ${found.pathname}`);
    console.log(`Params: token=${token} unit=${unit} quote=${quote} interval=${interval} start=${start} end=${end}`);
}

main().catch((e) => {
    console.error(e?.response?.data ?? e.stack ?? e.message ?? e);
    process.exit(1);
});
