// The Claude plan limits of the account the workers run on (the 5-hour session and the week) for
// the meter under the workers in the sidebar. Claude Code answers a `get_usage` control request on
// its stream-json protocol with the numbers its /usage screen shows. Asking starts no conversation
// and costs nothing, and Claude Code deals with the sign-in (keychain, token refresh) itself.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { get9routerWindows } from './9router.js';
const POLL_MS = 2 * 60_000;
/** Someone walking in, or clicking the meter, reads again, at most this often. */
const MIN_GAP_MS = 20_000;
const TIMEOUT_MS = 30_000;
/** No plan limits to show (an API key, Bedrock, Vertex, signed out): look again much later. */
const NO_PLAN_MS = 30 * 60_000;
/** After this many failed reads in a row (no network, a `claude` too old to answer), wait longer. */
const FAILS_BEFORE_BACKOFF = 3;
const BACKOFF_MS = 10 * 60_000;
const LABEL_MAX = 24;
export class PlanLimitsReader {
    claude;
    env;
    wanted;
    onChange;
    limits = { windows: [], at: 0 };
    /** Per-model weeks from the last answer that listed them; an answer from Claude Code's cache may not. */
    modelWeeks = [];
    timer;
    running = false;
    lastRead = 0;
    fails = 0;
    closed = false;
    /**
     * @param claude the `claude` binary, or null when it isn't installed (nothing is ever shown)
     * @param env environment for it (the office's own, minus anything that marks a child session)
     * @param wanted whether anyone is in the office to see the numbers; polls are skipped when not
     */
    constructor(claude, env, wanted, onChange) {
        this.claude = claude;
        this.env = env;
        this.wanted = wanted;
        this.onChange = onChange;
        this.schedule(0);
    }
    get state() {
        return this.limits;
    }
    /** Reads now, unless a read is running or one just finished. */
    refresh() {
        if (this.running || Date.now() - this.lastRead < MIN_GAP_MS)
            return;
        this.schedule(0);
    }
    close() {
        this.closed = true;
        clearTimeout(this.timer);
    }
    schedule(ms) {
        if (this.closed)
            return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.read(), ms);
        this.timer.unref();
    }
    async read() {
        if (!this.wanted())
            return this.schedule(POLL_MS);
        this.running = true;
        // 9Router limits must still be read when Claude CLI is unavailable.
        const answer = this.claude ? await ask(this.claude, this.env) : undefined;
        this.running = false;
        this.lastRead = Date.now();
        if (this.closed)
            return;
        let next = POLL_MS;
        if (answer === undefined) {
            this.fails = 0;
        }
        else if (answer === null) {
            if (++this.fails >= FAILS_BEFORE_BACKOFF) {
                this.fails = 0;
                next = BACKOFF_MS;
            }
        }
        else {
            this.fails = 0;
            this.limits = this.parse(answer);
            if (!this.limits.windows.length)
                next = NO_PLAN_MS;
        }
        try {
            const rawWindows = [...this.limits.windows];
            const nrWindows = await get9routerWindows();
            if (nrWindows && nrWindows.length) {
                rawWindows.push(...nrWindows);
                if (!this.limits.plan) this.limits.plan = '9Router';
                else if (!this.limits.plan.includes('9R')) this.limits.plan += ' + 9R';
            }
            this.limits.details = rawWindows;
            this.limits.windows = summarizeWindows(rawWindows);
        } catch {}
        this.onChange(this.limits);
        this.schedule(next);
    }
    parse(answer) {
        const rl = answer?.rate_limits;
        const plan = typeof answer?.subscription_type === 'string' ? answer.subscription_type.slice(0, LABEL_MAX) : undefined;
        if (answer?.rate_limits_available === false || !rl || typeof rl !== 'object') {
            this.modelWeeks = [];
            return { plan, windows: [], at: Date.now() };
        }
        const windows = [toWindow('5h session', rl.five_hour), toWindow('Week', rl.seven_day)];
        if (Array.isArray(rl.model_scoped)) {
            this.modelWeeks = rl.model_scoped
                .filter((m) => typeof m?.display_name === 'string' && m.display_name.trim())
                .map((m) => toWindow(`${m.display_name.trim().slice(0, LABEL_MAX)} week`, m))
                .filter((w) => w !== null);
        }
        else if (rl.seven_day_opus || rl.seven_day_sonnet) {
            // Claude Code before per-model buckets
            this.modelWeeks = [toWindow('Opus week', rl.seven_day_opus), toWindow('Sonnet week', rl.seven_day_sonnet)].filter((w) => w !== null);
        }
        return { plan, windows: [...windows.filter((w) => w !== null), ...this.modelWeeks], at: Date.now() };
    }
}
function toWindow(label, w) {
    if (typeof w?.utilization !== 'number' || !Number.isFinite(w.utilization))
        return null;
    const resetsAt = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
    const usedPct = Math.max(0, Math.min(100, w.utilization));
    return { provider: 'Claude', label, pct: usedPct, usedPct, remainingPct: Math.round(100 - usedPct), quotaAvailable: true, source: 'Claude usage', resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined };
}
function summarizeWindows(windows) {
    const groups = new Map();
    for (const window of windows) {
        if (window.kind === 'usage-summary') continue;
        const provider = window.provider || (window.label?.startsWith('9R:') ? '9Router' : 'Claude');
        const current = groups.get(provider) || { provider, label: provider, pct: 0, usedPct: 0, remainingPct: undefined, quotaAvailable: false, count: 0, resetsAt: undefined };
        current.pct = Math.max(current.pct, Number(window.usedPct ?? window.pct) || 0);
        current.usedPct = current.pct;
        if (window.quotaAvailable) {
            current.remainingPct = Math.max(0, 100 - current.pct);
            current.quotaAvailable = true;
        }
        current.count += 1;
        if (window.resetsAt && (!current.resetsAt || window.resetsAt < current.resetsAt)) current.resetsAt = window.resetsAt;
        groups.set(provider, current);
    }
    return [...groups.values()];
}
/** Claude Code's structured /usage answer, or null when it couldn't give one. */
function ask(claude, env) {
    const args = [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--tools', '',
        // Not the user's or the project's settings: no hooks, no MCP servers, no plugins, no transcript.
        '--setting-sources', '',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-session-persistence',
    ];
    return new Promise((resolve) => {
        let settled = false;
        let buf = '';
        const child = spawn(claude, args, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'] });
        const finish = (v) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(v);
            // No prompt was sent, so a closed stdin ends the session; a stuck one is killed.
            child.stdin.end();
            setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 10_000).unref();
        };
        const timer = setTimeout(() => finish(null), TIMEOUT_MS);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => {
            buf += d;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                let msg;
                try {
                    msg = JSON.parse(line);
                }
                catch {
                    continue;
                }
                const res = msg?.type === 'control_response' ? msg.response : undefined;
                if (res?.request_id === 'usage')
                    finish(res.subtype === 'success' ? (res.response ?? null) : null);
            }
        });
        child.on('error', () => finish(null));
        child.on('close', () => finish(null));
        child.stdin.on('error', () => { });
        child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n');
    });
}
