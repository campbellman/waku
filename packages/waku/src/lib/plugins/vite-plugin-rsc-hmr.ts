import type {
  HtmlTagDescriptor,
  Plugin,
  TransformResult,
  ViteDevServer,
} from 'vite';

import {
  joinPath,
  fileURLToFilePath,
  decodeFilePathFromAbsolute,
} from '../utils/path.js';

type ModuleImportResult = TransformResult & {
  id: string;
  // non-transformed result of `TransformResult.code`
  source: string;
  css?: boolean;
};

const WAKU_ATTR_NAME = 'waku-module-id';

const injectingHmrCode = `
import { createHotContext as __vite__createHotContext } from "/@vite/client";
import.meta.hot = __vite__createHotContext(import.meta.url);

if (import.meta.hot && !globalThis.__WAKU_HMR_CONFIGURED__) {
  globalThis.__WAKU_HMR_CONFIGURED__ = true;
  import.meta.hot.on('rsc-reload', () => {
    const wakuTags = document.querySelectorAll('[${WAKU_ATTR_NAME}]')
    for (let i = 0; i < wakuTags.length; i++) {
      wakuTags[i].remove();
    }
    const pathsToPrune = Array.from(import.meta.hot.hmrClient.pruneMap.keys())
    import.meta.hot.hmrClient.prunePaths(pathsToPrune)
    globalThis.__WAKU_RSC_RELOAD_LISTENERS__?.forEach((l) => l());
  });
  import.meta.hot.on('module-import', (data) => {
    let script = document.querySelector('script[${WAKU_ATTR_NAME}="' + data.id + '"]');
    let style = document.querySelector('style[${WAKU_ATTR_NAME}="' + data.id + '"]');
    script?.remove();
    const code = data.code;
    script = document.createElement('script');
    script.type = 'module';
    script.text = code;
    script.setAttribute('${WAKU_ATTR_NAME}', data.id);
    document.head.appendChild(script);
    // avoid HMR flash by first applying the new and removing the old styles 
    if (style) {
      queueMicrotask(style.remove);
    }
  });
}
`;

function waitForConnection(vite: ViteDevServer) {
  return new Promise<void>((resolve) => vite.ws.on('connection', resolve));
}

export function rscHmrPlugin(): Plugin {
  const wakuClientDist = decodeFilePathFromAbsolute(
    joinPath(fileURLToFilePath(import.meta.url), '../../../client.js'),
  );
  const wakuRouterClientDist = decodeFilePathFromAbsolute(
    joinPath(fileURLToFilePath(import.meta.url), '../../../router/client.js'),
  );
  return {
    name: 'rsc-hmr-plugin',
    enforce: 'post',
    async transformIndexHtml(_html, ctx) {
      return [
        ...(await generateInitialScripts(ctx.server)),
        {
          tag: 'script',
          attrs: { type: 'module', async: true },
          children: injectingHmrCode,
          injectTo: 'head',
        },
      ];
    },
    async transform(code, id) {
      if (id.startsWith(wakuClientDist)) {
        // FIXME this is fragile. Can we do it better?
        const FETCH_RSC_LINE =
          'export const fetchRSC = (input, searchParamsString, setElements, cache = fetchCache)=>{';
        return code.replace(
          FETCH_RSC_LINE,
          FETCH_RSC_LINE +
            `
{
  const refetchRsc = () => {
    cache.splice(0);
    const data = fetchRSC(input, searchParamsString, setElements, cache);
    setElements(data);
  };
  globalThis.__WAKU_RSC_RELOAD_LISTENERS__ ||= [];
  const index = globalThis.__WAKU_RSC_RELOAD_LISTENERS__.indexOf(globalThis.__WAKU_REFETCH_RSC__);
  if (index !== -1) {
    globalThis.__WAKU_RSC_RELOAD_LISTENERS__.splice(index, 1, refetchRsc);
  } else {
    globalThis.__WAKU_RSC_RELOAD_LISTENERS__.push(refetchRsc);
  }
  globalThis.__WAKU_REFETCH_RSC__ = refetchRsc;
}
`,
        );
      } else if (id.startsWith(wakuRouterClientDist)) {
        // FIXME this is fragile. Can we do it better?
        const INNER_ROUTER_LINE = 'function InnerRouter() {';
        return code.replace(
          INNER_ROUTER_LINE,
          INNER_ROUTER_LINE +
            `
{
  const refetchRoute = () => {
    const input = getInputString(loc.path);
    refetch(input, loc.searchParams);
  };
  globalThis.__WAKU_RSC_RELOAD_LISTENERS__ ||= [];
  const index = globalThis.__WAKU_RSC_RELOAD_LISTENERS__.indexOf(globalThis.__WAKU_REFETCH_ROUTE__);
  if (index !== -1) {
    globalThis.__WAKU_RSC_RELOAD_LISTENERS__.splice(index, 1, refetchRoute);
  } else {
    globalThis.__WAKU_RSC_RELOAD_LISTENERS__.unshift(refetchRoute);
  }
  globalThis.__WAKU_REFETCH_ROUTE__ = refetchRoute;
}
`,
        );
      }
    },
  };
}

const modulePendingMap = new WeakMap<ViteDevServer, Set<ModuleImportResult>>();

async function moduleImport(
  viteServer: ViteDevServer,
  result: ModuleImportResult,
) {
  let sourceSet = modulePendingMap.get(viteServer);
  if (!sourceSet) {
    sourceSet = new Set();
    modulePendingMap.set(viteServer, sourceSet);
    await waitForConnection(viteServer);
  }
  if (sourceSet.has(result)) {
    return;
  }
  sourceSet.add(result);
  viteServer.hot.send({
    type: 'custom',
    event: 'module-import',
    data: result,
  });
}

async function generateInitialScripts(
  viteServer: ViteDevServer | undefined,
): Promise<HtmlTagDescriptor[]> {
  if (!viteServer) {
    return [];
  }

  const sourceSet = modulePendingMap.get(viteServer);
  if (!sourceSet) {
    return [];
  }

  const scripts: HtmlTagDescriptor[] = [];
  let injectedBlockingViteClient = false;

  for (const result of sourceSet) {
    // CSS modules do not support result.source (empty) since ssr-transforming them gives the css keys
    // and client-transforming them gives the script tag for injecting them.
    if (result.id.endsWith('.module.css')) {
      if (!injectedBlockingViteClient) {
        // since we use the client-transformed script tag, we need to avoid FOUC by parse-blocking the vite client that the script imports
        // this way we make sure to run the CSS modules script tag before everything
        // blocking this way is not ideal but it works. It should be revisited.
        scripts.push({
          tag: 'script',
          attrs: { type: 'module', blocking: 'render', src: '/@vite/client' },
          injectTo: 'head-prepend',
        });
        injectedBlockingViteClient = true;
      }
      scripts.push({
        tag: 'script',
        // tried render blocking this script tag by data url imports but it gives `/@vite/client: Invalid relative url or base scheme isn't hierarchical.` which could not find a way to fix.
        attrs: { type: 'module', WAKU_ATTR_NAME: result.id },
        children: result.code,
        injectTo: 'head-prepend',
      });
      continue;
    }
    scripts.push({
      tag: 'style',
      attrs: { type: 'text/css', WAKU_ATTR_NAME: result.id },
      children: result.source,
      injectTo: 'body',
    });
  }

  return scripts;
}

export type HotUpdatePayload =
  | { type: 'full-reload' }
  | { type: 'custom'; event: 'rsc-reload' }
  | { type: 'custom'; event: 'hot-import'; data: string }
  | { type: 'custom'; event: 'module-import'; data: ModuleImportResult };

export function hotUpdate(vite: ViteDevServer, payload: HotUpdatePayload) {
  if (payload.type === 'full-reload') {
    vite.hot.send(payload);
  } else if (payload.event === 'rsc-reload') {
    modulePendingMap.get(vite)?.clear();
    vite.hot.send(payload);
  } else if (payload.event === 'module-import') {
    moduleImport(vite, payload.data);
  }
}
