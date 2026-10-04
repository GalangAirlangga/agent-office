import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const NINE_ROUTER_PORT = 20128;
const NINE_ROUTER_HOST = '127.0.0.1';
const CLI_TOKEN_SALT = '9r-cli-auth';

function get9routerToken() {
  try {
    const dataDir = path.join(os.homedir(), '.9router');
    const raw = fs.readFileSync(path.join(dataDir, 'machine-id'), 'utf8').trim();
    const secret = fs.readFileSync(path.join(dataDir, 'auth', 'cli-secret'), 'utf8').trim();
    if (!raw || !secret) return '';
    return crypto.createHash('sha256').update(raw + CLI_TOKEN_SALT + secret).digest('hex').substring(0, 16);
  } catch {
    return '';
  }
}

function fetchJson(reqPath, token, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: NINE_ROUTER_HOST,
        port: NINE_ROUTER_PORT,
        path: reqPath,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'x-9r-cli-token': token } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && body) {
            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/**
 * Reads 9router rate limits and usage stats, formatting them as PlanWindow[] for agent-office.
 */
export async function get9routerWindows() {
  const token = get9routerToken();
  const windows = [];

  try {
    // 1. Fetch provider connections
    const providersRes = token ? await fetchJson('/api/providers', token) : null;
    const connections = Array.isArray(providersRes?.connections) ? providersRes.connections : [];

    // 2. Fetch usage stats
    const statsRes = token ? await fetchJson('/api/usage/stats?period=today', token) : null;

    // 3. For active connections, check quota if available
    for (const conn of connections) {
      if (!conn.isActive) continue;
      const connName = conn.name || conn.provider || 'AI';

      // Try fetching specific provider quota
      const usageRes = token ? await fetchJson(`/api/usage/${conn.id}`, token) : null;
      if (usageRes && typeof usageRes === 'object') {
        const qs = usageRes.quotas;
        if (qs && typeof qs === 'object' && Object.keys(qs).length > 0) {
          let addedQuota = false;
          for (const [qname, q] of Object.entries(qs)) {
            if (!q || typeof q !== 'object') continue;
            let usedPct;
            if (typeof q.remainingPercentage === 'number' && Number.isFinite(q.remainingPercentage)) {
              usedPct = Math.max(0, Math.min(100, 100 - q.remainingPercentage));
            } else if (Number.isFinite(Number(q.total)) && Number(q.total) > 0 && Number.isFinite(Number(q.used))) {
              usedPct = Math.max(0, Math.min(100, (Number(q.used) / Number(q.total)) * 100));
            }
            if (usedPct === undefined) continue;
            const displayName = q.displayName || qname;
            const resetTime = q.resetAt ? Date.parse(q.resetAt) : undefined;
            windows.push({
              provider: conn.provider || conn.name || '9Router',
              connection: connName,
              label: displayName.slice(0, 24),
              pct: Math.round(usedPct),
              usedPct: Math.round(usedPct),
              remainingPct: Math.round(100 - usedPct),
              quotaAvailable: true,
              source: '9Router quota',
              resetsAt: Number.isFinite(resetTime) ? resetTime : undefined,
            });
            addedQuota = true;
          }
          if (addedQuota) continue;
        }

        const pct = typeof usageRes.utilization === 'number'
          ? Math.max(0, Math.min(100, usageRes.utilization))
          : typeof usageRes.percentage === 'number'
          ? Math.max(0, Math.min(100, usageRes.percentage))
          : null;

        if (pct !== null) {
          const resetTime = usageRes.resetsAt ? Date.parse(usageRes.resetsAt) : undefined;
          windows.push({
            provider: conn.provider || conn.name || '9Router',
            connection: connName,
            label: connName.slice(0, 24),
            pct: Math.round(pct),
            usedPct: Math.round(pct),
            remainingPct: Math.round(100 - pct),
            quotaAvailable: true,
            source: '9Router utilization',
            resetsAt: Number.isFinite(resetTime) ? resetTime : undefined,
          });
          continue;
        }
      }

      // Fallback: show active connection indicator
      windows.push({
        provider: conn.provider || conn.name || '9Router',
        connection: connName,
        label: connName.slice(0, 24),
        pct: 0,
        quotaAvailable: false,
        source: '9Router connection',
      });
    }

    // 4. Add summary token window if usage stats exist
    if (statsRes?.totalTokens || statsRes?.totalRequests) {
      const tokens = statsRes.totalTokens || 0;
      const fmt = tokens > 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : tokens > 1e3 ? `${Math.round(tokens / 1e3)}k` : `${tokens}`;
      windows.push({
        provider: '9Router',
        connection: 'today',
        label: `Tokens: ${fmt}`.slice(0, 24),
        kind: 'usage-summary',
        tokens,
      });
    }
  } catch {
    // Graceful fallback if 9router is down
  }

  return windows;
}

/**
 * Returns complete status of 9router for Hermes / API.
 */
export async function get9routerStatus() {
  const token = get9routerToken();
  const [modelsRes, providersRes, statsRes] = await Promise.all([
    fetchJson('/v1/models', token),
    token ? fetchJson('/api/providers', token) : Promise.resolve(null),
    token ? fetchJson('/api/usage/stats?period=today', token) : Promise.resolve(null),
  ]);

  const models = Array.isArray(modelsRes?.data) ? modelsRes.data.map((m) => ({
    id: m.id,
    ownedBy: m.owned_by,
    contextLength: m.context_length,
    capabilities: m.capabilities,
  })) : [];

  const connections = Array.isArray(providersRes?.connections) ? providersRes.connections.map((c) => ({
    id: c.id,
    name: c.name,
    provider: c.provider,
    isActive: c.isActive,
    defaultModel: c.defaultModel,
  })) : [];

  return {
    online: !!modelsRes || !!providersRes,
    totalModels: models.length,
    models,
    connections,
    todayStats: statsRes || null,
  };
}
