// Bounded activity log per floor. Max 100 events.
// Events: worker.hired, worker.exited, worker.status, task.queued, task.done, task.failed, pr.merged
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const MAX_EVENTS = 100;
export function loadActivity(dataDir) {
    const file = path.join(dataDir, 'activity.json');
    if (!existsSync(file)) return [];
    try {
        const raw = readFileSync(file, 'utf8');
        return JSON.parse(raw);
    } catch {
        return [];
    }
}
export function saveActivity(events, dataDir) {
    try {
        const file = path.join(dataDir, 'activity.json');
        writeFileSync(file, JSON.stringify(events, null, 2), { mode: 0o600 });
    } catch {
        // disk issue; ignore
    }
}
export function logActivity(dataDir, events, event) {
    const row = { id: events.length ? events[events.length - 1].id + 1 : 1, at: Date.now(), ...event };
    const trimmed = [...events, row].slice(-MAX_EVENTS);
    saveActivity(trimmed, dataDir);
    return trimmed;
}
