import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { isBusy } from '../shared/status.js';
import { DESK_BY_ID } from '../shared/layout.js';
import { excludeFromGit } from './config.js';
import { agentProviders, configuredProvider } from './agents.js';
import { WorkerManager, workedMs } from './workers.js';
import { GitHub, MergeWatch } from './github.js';
import { TaskQueue } from './queue.js';
import { Changes } from './changes.js';
import { Decor } from './decor.js';
import { FloorPlanStore } from './floorplan.js';
import { Docs } from './docs.js';
import { Dog } from './dog.js';
import { Court } from './court.js';
import { Jail } from './jail.js';
import { Garage } from './garage.js';
import { Jukebox } from './jukebox.js';
import { Whiteboard } from './whiteboard.js';
import { MeetingRoom } from './meetings.js';
import { Worktrees } from './worktrees.js';
import { landedWork, landedWorkers } from './leave-on-merge.js';
import { officePrompt } from './prompts.js';
import { loadActivity, logActivity } from '../shared/activity.js';
/** The open pull request on a floor's board whose head is `branch`. */
function openPull(floor, branch) {
    const pr = floor.github.pulls.items.find((p) => p.state === 'OPEN' && p.headRefName === branch);
    return pr ? { number: pr.number, url: pr.url } : undefined;
}
/** How long after a PR list or a worker's change the office looks for workers whose PR merged. */
const LANDED_DELAY_MS = 1500;
/** Boards on a floor nobody is on, with nothing running, are asked GitHub about this seldom. */
const IDLE_REFRESH_MS = 10 * 60_000;
const REFRESH_MS = 90_000;
/** What `git` says about a checkout: its name, branch and origin for the top bar. */
export function projectInfo(dir, name, agentCmd, agentArgs) {
    const git = (args) => {
        try {
            return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        }
        catch {
            return undefined;
        }
    };
    return {
        name,
        dir,
        branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
        remote: git(['remote', 'get-url', 'origin']),
        agentCmd: [agentCmd, ...agentArgs].join(' '),
        defaultProvider: configuredProvider(agentCmd),
        agentProviders: agentProviders(configuredProvider(agentCmd)),
    };
}
/**
 * One floor of the building: a project's checkout with its own desks and workers, issues and PR
 * boards, task queue, pictures and jukebox, all kept in that checkout's .agent-office folder.
 */
export class Floor {
    def;
    ctx;
    id;
    dir;
    project;
    workers;
    github;
    queue;
    changes;
    decor;
    /** The signs over its desks, and how far its back office is built out. */
    plan;
    jukebox;
    /** The whiteboard everyone on the floor draws on together. */
    whiteboard;
    /** The meeting room, where workers work through a question together (see meetings.ts). */
    meetings;
    /** The bookshelf: the project's Markdown files (see docs.ts). */
    docs;
    /** Settles once the workers whose terminals outlived the last office are picked back up, and the rest woken. */
    ready;
    dog;
    /** The basketball by the hoop: who has it, or how it was last thrown. */
    court = new Court();
    /** The cars in the garage: who's in which, and where their drivers have left them. */
    garage = new Garage();
    /** Workers sent home on a map that locks them up (see MapPlan.sendHome). */
    jail;
    timer;
    /** Pull requests merging, to ring the gong for. */
    merges = new MergeWatch();
    /** A look for workers whose pull request merged, due shortly (see sendLandedHome). */
    landedTimer;
    /** Workers across repositories whose worktrees are being checked before they go home. */
    landing = new Set();
    constructor(def, ctx) {
        this.def = def;
        this.ctx = ctx;
        this.id = def.id;
        this.dir = def.dir;
        const dataDir = path.join(def.dir, '.agent-office');
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        excludeFromGit(def.dir);
        this.project = projectInfo(def.dir, def.name, ctx.agentCmd, ctx.agentArgs);
        this.docs = new Docs(def.dir);
        // Bounded activity log per floor (max 100 events)
        this.activity = loadActivity(dataDir);
        this._loggedWorkers = new Map(); // workerId → last logged timestamp
        this._loggedTasks = new Set(); // task.id:type yang sudah di-log
        // Seed dedup keys from persisted history so a restart doesn't re-log the same state.
        // ponytail: keyed by worker name, so a genuinely new worker reusing a name within the
        // kept 100-event window won't be logged again. Use a worker incarnation id when available.
        for (const ev of this.activity) {
            const name = ev.detail?.name;
            if (!name) continue;
            if (ev.type === 'worker.hired') this._loggedWorkers.set(name, 'starting');
            else if (ev.type === 'worker.exited') this._loggedWorkers.set(name, 'exited');
            else if (ev.type === 'worker.status') this._loggedWorkers.set(name, ev.detail?.status || 'needs_input');
            const id = ev.detail?.id;
            if (id && ev.type.startsWith('task.')) this._loggedTasks.add(`${id}:${ev.type.split('.')[1]}`);
        }
        // Before the workers and the dog: the back office's desks are only there once it's built.
        this.plan = new FloorPlanStore(dataDir);
        this.jail = new Jail(dataDir);
        // Before the workers, so it hears about the ones who wake up needing input.
        this.dog = new Dog(def.id, dataDir, {
            workers: () => this.workers?.list() ?? [],
            people: () => ctx.peers(this),
            send: (dog) => ctx.emit(this, { t: 'dog', dog }),
            wing: () => this.plan.wing,
        });
        this.workers = new WorkerManager(def.dir, dataDir, ctx.agentCmd, ctx.agentArgs, ctx.hook, {
            update: (worker) => {
                ctx.emit(this, { t: 'worker.update', worker });
                // Log a worker lifecycle event only when its status actually changes — this
                // callback fires repeatedly (output, task assignment) for an unchanged status.
                const st = worker.status;
                if (st === 'starting' || st === 'exited' || st === 'needs_input') {
                    const last = this._loggedWorkers.get(worker.name);
                    if (last !== st) {
                        this._loggedWorkers.set(worker.name, st);
                        const type = st === 'starting' ? 'worker.hired' : st === 'exited' ? 'worker.exited' : 'worker.status';
                        this.logActivity(type, { name: worker.name, status: st });
                    }
                }
                this.queue?.onWorker(worker);
                this.meetings?.onWorker(worker);
                this.dog.onWorker(worker);
                ctx.workerChanged(this, worker);
                // Its turn ended, or whoever had its terminal open closed it: it may be free to go now.
                this.sendLandedHome();
            },
            remove: (workerId, info) => {
                this.changes?.forget(workerId);
                // Sent home on a map that locks workers up: into the dungeon with it, for good (a meeting's
                // workers aren't sent home when it's over, just let go).
                const jail = info && !info.meeting && ctx.locksUp() ? this.jail.add({ ...info, workedMs: workedMs(info) }) : undefined;
                ctx.emit(this, { t: 'worker.remove', workerId, ...(jail ? { jail } : {}) });
                this.queue?.onWorkerGone(workerId);
                this.meetings?.onWorkerGone(workerId);
                this.dog.onWorkerGone(workerId);
                ctx.workerChanged(this, workerId);
            },
            data: (workerId, data, viewers) => ctx.termData(workerId, data, viewers),
            screen: (workerId, frame) => ctx.emit(this, { t: 'screen', workerId, ...frame }, true),
            toast: (text, level) => ctx.toast(this, text, level),
        }, ctx.ledger, ctx.capacity, ctx.prompts, ctx.runAs, ctx.dshProfile);
        this.workers.wing = () => this.plan.wing;
        this.github = new GitHub(def.dir, (state) => ctx.emit(this, { t: 'gh.issues', state }), (state) => {
            ctx.emit(this, { t: 'gh.pulls', state });
            this.queue?.onPulls(state.items);
            if (state.loading || state.error)
                return;
            // A worker may have opened one from a branch it made itself, mid-turn or from a shell.
            void this.workers.syncBranches();
            for (const p of this.merges.look(state.items)) {
                ctx.toast(this, `🎉 PR #${p.number} merged: ${p.title}`);
                this.logActivity('pr.merged', { number: p.number, title: p.title });
                this.merged(p.number);
            }
            this.sendLandedHome();
            ctx.pullsChanged(this);
        });
        // The 📋 task queue seats workers by itself: it watches the workers and links PRs from GitHub.
        this.queue = new TaskQueue(dataDir, this.workers, !!this.project.branch, {
            update: (state) => {
                ctx.emit(this, { t: 'queue', state });
                // Log task lifecycle events — tracked by Set so shallow copies don't re-log.
                const tasks = state.tasks || [];
                for (const task of tasks) {
                    if (task.status === 'queued' && !this._loggedTasks.has(`${task.id}:queued`)) {
                        this._loggedTasks.add(`${task.id}:queued`);
                        this.logActivity('task.queued', { id: task.id, title: task.title });
                    }
                    if (task.status === 'done' && task.outcome === 'done' && !this._loggedTasks.has(`${task.id}:done`)) {
                        this._loggedTasks.add(`${task.id}:done`);
                        this.logActivity('task.done', { id: task.id, title: task.title });
                    }
                    if ((task.status === 'done' && task.outcome !== 'done') && !this._loggedTasks.has(`${task.id}:failed`)) {
                        this._loggedTasks.add(`${task.id}:failed`);
                        this.logActivity('task.failed', { id: task.id, title: task.title });
                    }
                }
                // A task's pull request may just have been linked (or merged).
                this.sendLandedHome();
            },
            toast: (text, level) => ctx.toast(this, text, level),
            claimIssue: (issue, owner) => {
                const as = ctx.ghAs(owner);
                return typeof as === 'string' ? Promise.resolve(as) : this.github.claim(issue, as);
            },
            refreshGitHub: () => void this.github.refresh(),
            hiringPaused: () => ctx.ledger.hiringPaused,
            room: () => ctx.capacity.room(),
            emptied: () => {
                ctx.toast(this, '📋 The queue is empty: every task is done 🎉');
                ctx.emit(this, { t: 'gong', why: 'queue' });
            },
            worktreeNote: () => officePrompt(ctx.prompts, 'queue.worktree'),
        });
        // Meetings seat their own workers round the meeting room's table and run them round by round.
        const workers = this.workers;
        this.meetings = new MeetingRoom(def.dir, dataDir, {
            defaultProvider: this.workers.defaultProvider,
            get officeDefault() {
                return workers.officeDefault;
            },
            list: () => this.workers.list(),
            seat: (deskId, by, prompt, provider, model, effort, meeting, owner) => this.workers.spawn(deskId, by, prompt, false, 'agent', provider, model, effort, meeting, owner),
            prompt: (id, text, by) => this.workers.prompt(id, text, by),
            write: (id, data, by) => this.workers.write(id, data, by),
            kill: (id) => this.workers.kill(id),
        }, this.project.branch ? new Worktrees(def.dir) : undefined, {
            update: (state) => ctx.emit(this, { t: 'meeting', state }),
            toast: (text, level) => ctx.toast(this, text, level),
            hiringPaused: () => ctx.ledger.hiringPaused,
            postReview: (pr, file, owner) => {
                const as = ctx.ghAs(owner);
                return typeof as === 'string' ? Promise.reject(new Error(as)) : this.github.review(pr, file, as);
            },
            prompt: (id) => ctx.prompts.text(id),
        });
        // What each worker changed, for the Changes window at its desk (see changes.ts).
        this.changes = new Changes(def.dir, this.project.branch, (workerId, repo) => {
            const w = this.workers.get(workerId);
            if (!w)
                return undefined;
            if (!repo)
                return { name: w.name, cwd: w.worktree ? path.join(def.dir, w.worktree.path) : def.dir, rel: w.worktree?.path ?? '', worktreeBase: w.worktree?.base };
            // One of the other floors' repositories it works in: diffed against, and PRs opened against, that floor's branch.
            const r = w.repos?.find((x) => x.floor === repo);
            if (!r)
                return undefined;
            const other = ctx.floor(r.floor);
            return {
                name: w.name,
                cwd: path.join(def.dir, r.path),
                rel: r.path,
                worktreeBase: r.base,
                baseBranch: r.from ?? null,
                openPull: (branch) => (other ? openPull(other, branch) : undefined),
                refreshGitHub: () => void other?.github.refresh(),
            };
        }, (branch) => openPull(this, branch), {
            state: (state, ids) => ctx.changes(state, ids),
            toast: (text, level) => ctx.toast(this, text, level),
            refreshGitHub: () => void this.github.refresh(),
        });
        this.decor = new Decor(dataDir);
        this.jukebox = new Jukebox(dataDir);
        this.whiteboard = new Whiteboard(dataDir);
        this.ready = this.workers.start();
        void this.github.refresh();
        // A floor with people on it, or work under way, keeps its boards fresh; the others check in now and then.
        this.timer = setInterval(() => {
            if (this.active() || Date.now() - this.github.issues.fetchedAt > IDLE_REFRESH_MS)
                void this.github.refresh();
        }, REFRESH_MS);
    }
    /** Pull request `n` merged (`by` someone, from the PR window): the gong rings, once per PR. */
    merged(n, by) {
        if (this.merges.ring(n))
            this.ctx.emit(this, { t: 'gong', why: 'merged', pr: n, by });
    }
    /**
     * With ⚙️ Settings' *go home once merged* on, sends home every worker whose pull request merged,
     * once it's at rest and nobody has its terminal open, deleting its worktree and branch unless they
     * hold work that isn't on GitHub. Called whenever that might have changed; it looks a moment later,
     * once for a burst of calls, and not from inside the event that prompted it.
     */
    sendLandedHome() {
        if (this.landedTimer || !this.ctx.leaveOnMerge())
            return;
        this.landedTimer = setTimeout(() => {
            this.landedTimer = undefined;
            if (!this.ctx.leaveOnMerge())
                return;
            const pullsOf = (id) => this.ctx.floor(id)?.github.pulls.items;
            for (const landed of landedWorkers(this.workers.list(), this.github.pulls.items, this.queue.state().tasks, pullsOf)) {
                const { worker, head, heads } = landed;
                if (!worker.repos?.length) {
                    this.goHome(worker, `PR #${landed.pr} merged`, head);
                    continue;
                }
                // Across repositories, one PR can merge before another repository's work even has one:
                // it goes once nothing is left that its merged PRs didn't deliver.
                if (this.landing.has(worker.id))
                    continue;
                this.landing.add(worker.id);
                void this.workers.holdsWork(worker.id, head, heads).catch(() => true).then((held) => {
                    this.landing.delete(worker.id);
                    if (!held && this.workers.get(worker.id) === worker)
                        this.goHome(worker, `its pull requests merged (${landed.prs?.join(', ')})`, head, heads);
                });
            }
        }, LANDED_DELAY_MS);
    }
    /**
     * Whether a worker's work landed: a pull request of its merged and none is open, on this floor
     * and, for a worker across repositories, on the others too (see landedWork).
     */
    landed(worker) {
        return landedWork(worker, this.github.pulls.items, this.queue.state().tasks, (id) => this.ctx.floor(id)?.github.pulls.items);
    }
    /**
     * Sends a worker home as someone asked (not by itself, see sendLandedHome): with no `cleanup`, its
     * worktree and branch go unless they hold work, where what its merged pull requests delivered
     * doesn't count. Resolves with the line about its worktree.
     */
    sendHome(workerId, cleanup) {
        const info = this.workers.get(workerId);
        const landed = info && this.landed(info);
        return this.workers.kill(workerId, cleanup, landed?.head, landed?.heads);
    }
    goHome(worker, why, head, heads) {
        const done = this.workers.kill(worker.id, undefined, head, heads);
        this.ctx.toast(this, `🏠 ${worker.name} went home: ${why}`);
        void done.then(({ note, error }) => {
            if (note)
                this.ctx.toast(this, note);
            if (error)
                this.ctx.toast(this, error, 'warn');
        });
    }
    /** Someone just walked in: boards that haven't been looked at in a while get fetched again. */
    arrived() {
        if (Date.now() - Math.max(this.github.issues.fetchedAt, this.github.pulls.fetchedAt) > REFRESH_MS)
            void this.github.refresh();
    }
    active() {
        return this.ctx.people(this) > 0 || this.ctx.lent(this) || this.workers.list().some((w) => isBusy(w.status)) || this.queue.state().tasks.some((t) => t.status !== 'done') || this.meetings.state().current?.status === 'running';
    }
    health() {
        const allWorkers = this.workers.list();
        const workers = allWorkers.filter((w) => !DESK_BY_ID.get(w.deskId)?.station);
        const workerCounts = {
            total: workers.length,
            working: workers.filter((w) => w.status === 'working').length,
            idle: workers.filter((w) => w.status === 'idle').length,
            done: workers.filter((w) => w.status === 'done').length,
            needsInput: workers.filter((w) => w.status === 'needs_input').length,
            exited: workers.filter((w) => w.status === 'exited').length,
            offline: workers.filter((w) => w.status === 'offline').length,
        };
        const queue = this.queue.state();
        const tasks = queue.tasks || [];
        const queueCounts = {
            queued: tasks.filter((t) => t.status === 'queued').length,
            running: tasks.filter((t) => t.status === 'running').length,
            done: tasks.filter((t) => t.status === 'done').length,
            failed: tasks.filter((t) => t.status === 'failed' || t.outcome === 'failed' || !!t.error).length,
            maxWorkers: queue.maxWorkers,
        };
        const pulls = this.github.pulls.items || [];
        const openPulls = pulls.filter((p) => p.state === 'OPEN');
        const pullRequests = {
            open: openPulls.length,
            draft: openPulls.filter((p) => p.isDraft).length,
            review: openPulls.filter((p) => ['REVIEW_REQUIRED', 'CHANGES_REQUESTED'].includes(p.reviewDecision)).length,
        };
        const timestamps = [
            ...workers.flatMap((w) => [w.createdAt, w.lastInput?.at, w.waitingSince]),
            ...tasks.flatMap((t) => [t.addedAt, t.startedAt, t.finishedAt]),
            ...pulls.map((p) => Date.parse(p.updatedAt || '')),
        ].filter((at) => Number.isFinite(at));
        const lastActivityAt = timestamps.length ? Math.max(...timestamps) : undefined;
        const reasons = [];
        if (workerCounts.needsInput)
            reasons.push(`${workerCounts.needsInput} worker menunggu input`);
        if (queueCounts.failed)
            reasons.push(`${queueCounts.failed} task gagal`);
        if (workerCounts.exited || workerCounts.offline)
            reasons.push(`${workerCounts.exited + workerCounts.offline} worker berhenti/offline`);
        if (queueCounts.queued)
            reasons.push(`${queueCounts.queued} task menunggu queue`);
        if (pullRequests.review)
            reasons.push(`${pullRequests.review} PR perlu review`);
        let status = 'healthy';
        if (workerCounts.needsInput || queueCounts.failed)
            status = 'blocked';
        else if (!workerCounts.total && !queueCounts.queued && !queueCounts.running)
            status = 'idle';
        else if (reasons.length)
            status = 'attention';
        return {
            status,
            reasons,
            workers: workerCounts,
            queue: queueCounts,
            pullRequests,
            lastActivityAt,
        };
    }
    /** Bounded activity log per floor (max 100 events). Called from workers/queue/github callbacks. */
    logActivity(type, detail) {
        this.activity = logActivity(
            path.join(this.dir, '.agent-office'),
            this.activity,
            { type, floorId: this.id, detail },
        );
    }
    info() {
        const ws = this.workers.list();
        return {
            id: this.id,
            name: this.def.name,
            repo: this.def.repo,
            dir: this.dir,
            branch: this.project.branch,
            palette: this.def.palette,
            addedBy: this.def.addedBy,
            addedAt: this.def.addedAt,
            workers: ws.filter((w) => !DESK_BY_ID.get(w.deskId)?.station).length,
            busy: ws.filter((w) => w.status === 'working').length,
            waiting: ws.filter((w) => w.kind === 'agent' && (w.status === 'needs_input' || (w.status === 'done' && !w.acked))).length,
            health: this.health(),
            people: this.ctx.people(this),
            wing: this.plan.wing,
        };
    }
    /** With `keep` (a restart), the workers' terminals keep running for the next office to pick up. */
    shutdown(keep = false) {
        clearInterval(this.timer);
        clearTimeout(this.landedTimer);
        this.dog.stop();
        this.github.stop();
        this.queue.shutdown();
        this.meetings.shutdown();
        this.changes.stop();
        this.whiteboard.flush();
        this.workers.shutdown(keep);
    }
}
