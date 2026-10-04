import { readBody, send } from '../util.js';
import { get9routerStatus, get9routerWindows } from '../../9router.js';
import { DESK_BY_ID } from '../../../shared/layout.js';
import path from 'node:path';
import { loadActivity } from '../../../shared/activity.js';

function groupLimitProviders(windows) {
  const groups = new Map();
  for (const window of windows) {
    if (window?.kind === 'usage-summary') continue;
    const provider = window.provider || (window.label?.startsWith('9R:') ? '9Router' : 'Claude');
    const current = groups.get(provider) || {
      provider,
      pct: 0,
      usedPct: 0,
      remainingPct: undefined,
      quotaAvailable: false,
      count: 0,
      resetsAt: undefined,
      windows: []
    };
    const used = Number(window.usedPct ?? window.pct);
    if (window.quotaAvailable !== false && Number.isFinite(used)) {
      current.pct = Math.max(current.pct, used);
      current.usedPct = current.pct;
      current.remainingPct = Math.max(0, 100 - current.pct);
      current.quotaAvailable = true;
    }
    current.count += 1;
    if (window.resetsAt && (!current.resetsAt || window.resetsAt < current.resetsAt)) {
      current.resetsAt = window.resetsAt;
    }
    current.windows.push(window);
    groups.set(provider, current);
  }
  return [...groups.values()];
}

export const hermesRoutes = {
  // POST /api/hermes/task
  task: {
    method: 'POST',
    path: '/api/hermes/task',
    auth: 'public',
    async handle(ctx, { req, res }) {
      try {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const { prompt, title, floor: floorName, provider, model, effort, issue } = body;

        if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
          return send(res, 400, { success: false, error: 'Prompt is required' });
        }

        // Find matching floor or pick the first floor
        let targetFloor;
        if (floorName) {
          targetFloor = ctx.floors.get(floorName) ||
            [...ctx.floors.values()].find((f) => f.def.name === floorName || f.def.repo?.includes(floorName));
          if (!targetFloor) {
            return send(res, 404, {
              success: false,
              error: `Floor '${floorName}' not found. Available: ${[...ctx.floors.values()].map(f => f.def.name).join(', ')}`
            });
          }
        } else {
          targetFloor = ctx.floors.values().next().value;
          if (!targetFloor) {
            return send(res, 500, { success: false, error: 'No floors open in agent-office' });
          }
        }

        // Queue task
        const err = targetFloor.queue.add(
          prompt,
          'hermes',
          title || prompt.split('\n')[0].slice(0, 80),
          issue ? Number(issue) : undefined,
          provider,
          model,
          effort
        );

        if (err) {
          return send(res, 400, { success: false, error: err });
        }

        const currentTasks = targetFloor.queue.state().tasks;
        const queuedTask = currentTasks[currentTasks.length - 1];

        return send(res, 200, {
          success: true,
          floor: targetFloor.def.name,
          repo: targetFloor.def.repo,
          task: queuedTask,
          queueLength: currentTasks.length,
        });
      } catch (err) {
        return send(res, 500, { success: false, error: String(err?.message || err) });
      }
    },
  },

  // GET /api/hermes/backlog
  backlog: {
    method: 'GET',
    path: '/api/hermes/backlog',
    auth: 'public',
    async handle(ctx, { url, res }) {
      try {
        const floorFilter = url.searchParams.get('floor');
        const floorsData = [];

        for (const [id, floor] of ctx.floors) {
          if (floorFilter && id !== floorFilter && floor.def.name !== floorFilter && !floor.def.repo?.includes(floorFilter)) {
            continue;
          }

          const issues = Array.isArray(floor.github?.issues?.items)
            ? floor.github.issues.items.map((i) => ({
                number: i.number,
                title: i.title,
                url: i.url,
                labels: Array.isArray(i.labels) ? i.labels : [],
                author: i.author?.login || i.author,
                createdAt: i.createdAt,
              }))
            : [];

          const pulls = Array.isArray(floor.github?.pulls?.items)
            ? floor.github.pulls.items.map((p) => ({
                number: p.number,
                title: p.title,
                url: p.url,
                state: p.state,
                branch: p.headRefName,
                author: p.author?.login || p.author,
                createdAt: p.createdAt,
              }))
            : [];

          floorsData.push({
            floorId: id,
            name: floor.def.name,
            repo: floor.def.repo,
            branch: floor.project?.branch,
            openIssuesCount: issues.length,
            openPullsCount: pulls.length,
            health: floor.health?.(),
            issues,
            pulls,
          });
        }

        return send(res, 200, { success: true, floors: floorsData });
      } catch (err) {
        return send(res, 500, { success: false, error: String(err?.message || err) });
      }
    },
  },

  // GET /api/hermes/status
  status: {
    method: 'GET',
    path: '/api/hermes/status',
    auth: 'public',
    async handle(ctx, { res }) {
      try {
        const floors = [];
        for (const [id, floor] of ctx.floors) {
          const workers = (floor.workers?.list?.() || [])
            .filter((worker) => !DESK_BY_ID.get(worker.deskId)?.station);

          floors.push({
            id,
            name: floor.def.name,
            repo: floor.def.repo,
            workers,
            queue: floor.queue?.state()?.tasks || [],
            health: floor.health?.(),
          });
        }

        const nineRouter = await get9routerStatus();

        return send(res, 200, {
          success: true,
          floors,
          nineRouter,
        });
      } catch (err) {
        return send(res, 500, { success: false, error: String(err?.message || err) });
      }
    },
  },

  // GET /api/hermes/activity
  activity: {
    method: 'GET',
    path: '/api/hermes/activity',
    auth: 'public',
    async handle(ctx, { url, res }) {
      try {
        const floorId = url.searchParams.get('floor');
        const limit = Math.min(100, Math.max(10, Number(url.searchParams.get('limit')) || 50));
        const result = [];
        for (const [id, floor] of ctx.floors) {
          if (floorId && id !== floorId) continue;
          const activity = floor.activity || loadActivity(path.join(floor.dir, '.agent-office'));
          result.push({
            floorId: id,
            name: floor.def.name,
            activity: activity.slice(-limit),
          });
        }
        return send(res, 200, { success: true, result });
      } catch (err) {
        return send(res, 500, { success: false, error: String(err?.message || err) });
      }
    },
  },

  // GET /api/hermes/limits
  limits: {
    method: 'GET',
    path: '/api/hermes/limits',
    auth: 'public',
    async handle(ctx, { res }) {
      try {
        const limits = ctx.limits?.state || { windows: [], details: [], at: 0 };
        let windows = limits.details?.length ? limits.details : limits.windows || [];
        if (!windows.length) {
          try {
            windows = await get9routerWindows();
          } catch {}
        }
        const providers = groupLimitProviders(windows);
        return send(res, 200, { success: true, limits: { ...limits, details: windows }, providers });
      } catch (err) {
        return send(res, 500, { success: false, error: String(err?.message || err) });
      }
    },
  },
};
