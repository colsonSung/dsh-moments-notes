import { access, copyFile, link, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { openRepository } from './lib/repository.js';
import { openCanvasRepository } from './lib/canvas-repository.js';
import { createHostService, createMemoTool } from './lib/host-service.js';
import { createDesignTools } from './lib/design-tools.js';
import { createDesignPreviewHandler } from './lib/design-export.js';
import { createDraftStore } from './lib/draft.js';
import { createFetchHandler, ROUTE } from './lib/http.js';
import { openDiagnostics } from './lib/diagnostics.js';
import { ASSET_ROUTE, createAssetHandler, openAssetStore } from './lib/asset-store.js';
import { disposePluginResources } from './lib/lifecycle.js';
import { buildMiniPage } from './lib/mini.js';
import { DesktopFloat } from './lib/desktop-float.js';
import { createFloatBridge } from './lib/float-bridge.js';

export { ROUTE } from './lib/http.js';
export const name = 'moments-notes';
export const inject = ['tools', 'connection', 'profileContext'];

/** Route of the standalone floating mini window. */
export const MINI_ROUTE = '/api/moments-notes/mini';
/** Route that serves one board as the SVG a chat tool card previews. */
export const DESIGN_PREVIEW_ROUTE = '/api/moments-notes/design-preview';

const DAILY_MS = 24 * 60 * 60 * 1000;

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the Moments store, copying the newest previous store once without deleting backups. */
export async function prepareDataFile(ctx) {
  const profileDir = typeof ctx.profileContext?.dir === 'string'
    ? ctx.profileContext.dir
    : process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh');
  const filePath = join(profileDir, 'moments-notes', 'notes.json');
  if (await exists(filePath)) return filePath;
  for (const legacyName of ['shiguang-notes', 'flomo-notes']) {
    const legacyPath = join(profileDir, legacyName, 'notes.json');
    if (!(await exists(legacyPath))) continue;
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.migrating-${process.pid}.tmp`;
    try {
      await copyFile(legacyPath, temporary);
      try {
        await link(temporary, filePath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
    break;
  }
  return filePath;
}

/** Activate the persistent Host service, authenticated UI route and agent tool. */
export async function apply(ctx) {
  const dataFile = await prepareDataFile(ctx);
  const repository = await openRepository({ filePath: dataFile });
  // The float keeps an unfinished thought in a file of its own, so closing the
  // window never costs the person what they had typed.
  const draftStore = createDraftStore({
    filePath: join(dirname(dataFile), 'draft.json'),
    logger: ctx.logger,
  });
  let disposeRoute;
  let disposeTool;
  let disposeMiniRoute;
  let disposeAssetRoute;
  let disposePurgeTimer;
  let disposeFloat;
  let disposeDesignTools;
  let disposeDesignPreview;
  let closeCanvasRepository;
  const closeRepository = () => repository.close();
  try {
    // The canvas keeps its boards in a file of its own, so a broken board
    // store cannot reach into the notes: the canvas stays unavailable until
    // the file is repaired, and the notes keep working.
    let canvasRepository = null;
    try {
      canvasRepository = await openCanvasRepository({
        filePath: join(dirname(dataFile), 'canvases.json'),
      });
      closeCanvasRepository = () => canvasRepository.close();
    } catch (error) {
      ctx.logger?.warn?.(`Moments canvas store is unavailable: ${String(error)}`);
    }
    // The desktop float is a separate operating-system window, so it cannot
    // live inside the Harness page; the Host owns the process instead.
    // Pictures are files of their own: a board is saved whole on every
    // change, so an inline screenshot would make each save rewrite megabytes.
    const assetStore = await openAssetStore({ directory: join(dirname(dataFile), 'assets') });
    const desktopFloat = new DesktopFloat();
    const floatBridge = createFloatBridge({ repository, desktopFloat, draftStore });
    // One append-only log holds every failure the Host answers and every
    // error the browser reports, so a message on screen can be traced.
    const diagnostics = await openDiagnostics({ filePath: join(dirname(dataFile), 'diagnostics.log') })
      .catch(() => null);
    const service = createHostService({ repository, floatBridge, canvasRepository, assets: assetStore, diagnostics });
    ctx.provide?.('momentsNotes', service);
    disposeRoute = ctx.connection.fetch.register({
      path: ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createFetchHandler(service, { diagnostics }),
    });
    disposeMiniRoute = ctx.connection.fetch.register({
      path: MINI_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => new Response(buildMiniPage(), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      }),
    });
    // The chat card previews a board through this route: same renderer as the
    // SVG deliverable, so what the card shows is what the export contains.
    disposeDesignPreview = ctx.connection.fetch.register({
      path: DESIGN_PREVIEW_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: createDesignPreviewHandler({ getCanvasStore: () => canvasRepository }),
    });
    disposeAssetRoute = ctx.connection.fetch.register({
      path: ASSET_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: createAssetHandler(assetStore),
    });
    disposeTool = ctx.tools.register(createMemoTool({ repository }));
    // The agent authors the design canvas through the same Host store the
    // Design panel reads, so an agent-built board is an ordinary board.
    const designDisposers = createDesignTools({ getCanvasStore: () => canvasRepository, diagnostics })
      .map((tool) => ctx.tools.register(tool));
    disposeDesignTools = () => {
      for (const dispose of designDisposers) dispose();
    };
    const purgeTimer = setInterval(() => {
      repository.purgeExpired().catch((error) => {
        ctx.logger?.warn?.(`Moments trash retention failed: ${String(error)}`);
      });
    }, DAILY_MS);
    purgeTimer.unref?.();
    disposePurgeTimer = () => clearInterval(purgeTimer);
    disposeFloat = () => floatBridge.dispose();
    ctx.effect(
      () => () => disposePluginResources([
        disposeRoute, disposeMiniRoute, disposeAssetRoute, disposeDesignPreview, disposeTool, disposeDesignTools,
        disposePurgeTimer,
        disposeFloat, closeCanvasRepository, closeRepository,
      ]),
      'moments-notes: persistence, routes, assets, tools, desktop float and trash retention',
    );
  } catch (error) {
    try {
      await disposePluginResources([
        disposeRoute, disposeMiniRoute, disposeAssetRoute, disposeDesignPreview, disposeTool, disposeDesignTools,
        disposePurgeTimer,
        disposeFloat, closeCanvasRepository, closeRepository,
      ]);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Moments activation and rollback failed');
    }
    throw error;
  }
}
