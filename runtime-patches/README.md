# Runtime Patches for v0.1.183

This directory contains runtime-only patches for Agent Office v0.1.183.

Because Agent Office is installed via script (not built from source in development),
changes to `dist/` are lost on updates. This directory preserves those changes.

## Current Patches: v0.1.183

### Backend (`server/server/`)

- **floor.js**: Added activity log system with bounded persistence (max 100 events).
  - `logActivity()` method for event tracking
  - `_loggedWorkers` Map and `_loggedTasks` Set for deduplication across restarts
  - `health()` method for floor health summary (healthy/attention/blocked/idle)
  - Worker update handler logs `worker.hired`, `worker.exited`, `worker.status`
  - Queue update handler logs `task.queued`, `task.done`, `task.failed`
  - Fixed failed task filter to include `t.status === 'failed'`

- **http/routes/hermes.js**: Added activity endpoint
  - GET `/api/hermes/activity?floor=...&limit=...`
  - Filters board agents from worker list

- **http/routes/index.js**: Added `hermesRoutes.activity` to routes

### Server Shared (`server/shared/`)

- **activity.js**: New file implementing bounded activity log
  - `loadActivity()`, `saveActivity()`, `logActivity()` functions
  - MAX_EVENTS = 100

### Frontend 2D (`public/`)

- **lite.html**: Added
  - `<script src="/assets/lite-activity.js">`
  - `<button id="btn-activity">📜 Activity</button>` in nav

- **assets/lite-health.js**: Complete rewrite
  - Worker Action Center with Resume, Prompt, PR, Worktree, Send Home actions
  - Failed task with Retry button
  - Confirmation dialogs for destructive actions

- **assets/lite-activity.js**: New file
  - Activity timeline modal
  - Floor-separated event list
  - Relative time formatting

- **assets/lite-DSwRnFsb.css**: Mobile fixes
  - Nav grid: 6 columns → 3×2 on screens ≤640px
  - Added health section classes (`.health-section-title`, `.health-worker`, etc.)
  - Added activity classes (`.activity-floor`, `.activity-list`, `.activity-row`)

### Frontend 3D (`public/`)

- **assets/main-health.js**: New file
  - Health sidebar panel
  - Renders floor status, counts, reasons, last activity age

- **assets/main-C_o7lGkU.css**: Appended health3 classes

- **public/index.html**: Added `<script src="/assets/main-health.js">`

## Applying Patches

To apply these patches to a fresh installation:

```bash
# After installing agent-office via the official script
APPLIED_VERSION=$(curl -s https://api.github.com/repos/AgentSystemLabs/agent-office/releases/latest | jq -r .tag_name)
PATCH_DIR="runtime-patches/$APPLIED_VERSION"

if [ -d "/home/$(whoami)/.local/share/agent-office/versions/$APPLIED_VERSION/dist" ]; then
    # Backup original files
    for f in $PATCH_DIR/**/*.{js,css,html}; do
        cp "$f" "/tmp/$(basename $f).bak" 2>/dev/null || true
    done
    
    # Apply patches
    cp -r "$PATCH_DIR/public/"* "/home/$(whoami)/.local/share/agent-office/versions/$APPLIED_VERSION/dist/public/"
    cp -r "$PATCH_DIR/server/"* "/home/$(whoami)/.local/share/agent-office/versions/$APPLIED_VERSION/dist/server/"
    
    # Restart service
    systemctl --user restart agent-office
fi
```

## To Contribute Changes

1. Clone the upstream repo
2. Make changes in `src/`
3. Build with `npm run build`
4. The built `dist/` files will include your changes
5. Test in a development environment
6. Submit PR to upstream

Or, for runtime-only changes:

1. Modify `dist/` files directly
2. Write new files to appropriate `runtime-patches/vX.Y.Z/` subdirectories
3. Update this README with a summary of changes