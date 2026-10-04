import { agentRoutes } from './agents.js';
import { authRoutes } from './auth.js';
import { fileRoutes } from './files.js';
import { githubRoutes } from './github.js';
import { pageRoutes } from './pages.js';
import { searchRoutes } from './search.js';
import { hermesRoutes } from './hermes.js';
export const routes = [
    // Anyone / Hermes Bot.
    hermesRoutes.task,
    hermesRoutes.backlog,
    hermesRoutes.status,
    hermesRoutes.limits,
    hermesRoutes.activity,
    authRoutes.login,
    authRoutes.loginOptions,
    authRoutes.join,
    authRoutes.claimable,
    authRoutes.claim,
    authRoutes.link,
    authRoutes.logout,
    pageRoutes.health,
    pageRoutes.assets,
    pageRoutes.login,
    pageRoutes.claim,
    pageRoutes.join,
    pageRoutes.favicon,
    // Signed in.
    authRoutes.whoami,
    agentRoutes.openCodeModels,
    agentRoutes.grokModels,
    fileRoutes.image,
    fileRoutes.whiteboardFile,
    fileRoutes.termDrop,
    fileRoutes.changedFile,
    fileRoutes.docs,
    searchRoutes.search,
    githubRoutes.github,
    pageRoutes.office,
    pageRoutes.lite,
    pageRoutes.bundle,
];
