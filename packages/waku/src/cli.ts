import path from 'node:path';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import type { Env } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import * as swc from '@swc/core';
import dotenv from 'dotenv';

import type { Config } from './config.js';
import type { Api } from './server.js';
import { resolveConfig } from './lib/config.js';
import { honoMiddleware as honoDevMiddleware } from './lib/middleware/hono-dev.js';
import { honoMiddleware as honoPrdMiddleware } from './lib/middleware/hono-prd.js';
import { build } from './lib/builder/build.js';
import { extname } from './lib/utils/path.js';

const require = createRequire(new URL('.', import.meta.url));

dotenv.config({ path: ['.env.local', '.env'] });

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    'with-ssr': {
      type: 'boolean',
    },
    'with-vercel': {
      type: 'boolean',
    },
    'with-vercel-static': {
      type: 'boolean',
    },
    'with-cloudflare': {
      type: 'boolean',
    },
    'with-deno': {
      type: 'boolean',
    },
    'with-netlify': {
      type: 'boolean',
    },
    'with-netlify-static': {
      type: 'boolean',
    },
    'with-aws-lambda': {
      type: 'boolean',
    },
    version: {
      type: 'boolean',
      short: 'v',
    },
    help: {
      type: 'boolean',
      short: 'h',
    },
  },
});

const config = await loadConfig();

const cmd = positionals[0];

if (values.version) {
  const { version } = require('../package.json');
  console.log(version);
} else if (values.help) {
  displayUsage();
} else {
  const ssr = !!values['with-ssr'];
  switch (cmd) {
    case 'dev':
      runDev({ ssr });
      break;
    case 'build':
      runBuild({
        ssr,
      });
      break;
    case 'start':
      runStart({ ssr });
      break;
    default:
      if (cmd) {
        console.error('Unknown command:', cmd);
      }
      displayUsage();
      break;
  }
}

async function runDev(options: { ssr: boolean }) {
  const resolvedConfig = await resolveConfig(config);

  const middlewareHandler = honoDevMiddleware<Env>({
    ...options,
    config,
    env: process.env as any,
  });

  const app = new Hono();
  const api = await loadDevApi();
  if (api) {
    const apiOptions = {
      config: resolvedConfig,
      middlewareHandlers: [middlewareHandler],
    };
    await api(app, apiOptions);
  } else {
    app.use('*', middlewareHandler);
  }

  const port = parseInt(process.env.PORT || '3000', 10);
  startServer(app, port);
}

async function runBuild(options: { ssr: boolean }) {
  await build({
    ...options,
    config,
    env: process.env as any,
    deploy:
      (values['with-vercel'] ?? !!process.env.VERCEL
        ? values['with-vercel-static']
          ? 'vercel-static'
          : 'vercel-serverless'
        : undefined) ||
      (values['with-cloudflare'] ? 'cloudflare' : undefined) ||
      (values['with-deno'] ? 'deno' : undefined) ||
      (values['with-netlify'] ?? !!process.env.NETLIFY
        ? values['with-netlify-static']
          ? 'netlify-static'
          : 'netlify-functions'
        : undefined) ||
      (values['with-aws-lambda'] ? 'aws-lambda' : undefined),
  });
}

async function runStart(options: { ssr: boolean }) {
  const resolvedConfig = await resolveConfig(config);
  const { distDir, publicDir, entriesJs } = resolvedConfig;

  const staticServeMiddlewareHandler = serveStatic({
    root: path.join(distDir, publicDir),
  });
  const prdMiddlewareHandler = honoPrdMiddleware<Env>({
    ...options,
    config,
    loadEntries: () =>
      import(pathToFileURL(path.resolve(distDir, entriesJs)).toString()),
    env: process.env as any,
  });

  const app = new Hono();
  const api = await loadPrdApi();
  if (api) {
    const apiOptions = {
      config: resolvedConfig,
      middlewareHandlers: [staticServeMiddlewareHandler, prdMiddlewareHandler],
    };
    await api(app, apiOptions);
  } else {
    app.use('*', staticServeMiddlewareHandler);
    app.use('*', prdMiddlewareHandler);
  }
  const port = parseInt(process.env.PORT || '8080', 10);
  startServer(app, port);
}

async function startServer(app: Hono, port: number) {
  const server = serve({ ...app, port }, () => {
    console.log(`ready: Listening on http://localhost:${port}/`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`warn: Port ${port} is in use, trying ${port + 1} instead.`);
      startServer(app, port + 1);
    } else {
      console.error(`Failed to start server: ${err.message}`);
    }
  });
}

function displayUsage() {
  console.log(`
Usage: waku [options] <command>

Commands:
  dev         Start the development server
  build       Build the application for production
  start       Start the production server

Options:
  --with-ssr            Use opt-in SSR
  --with-vercel         Output for Vercel on build
  --with-cloudflare     Output for Cloudflare on build
  --with-deno           Output for Deno on build
  --with-netlify        Output for Netlify on build
  --with-aws-lambda     Output for AWS Lambda on build
  -v, --version         Display the version number
  -h, --help            Display this help message
`);
}

// TODO: should we call `loadApi` directly rather than splitting into two functions?
const loadPrdApi = () => loadApi('prd');
const loadDevApi = () => loadApi('dev');

async function loadApi(env: 'dev' | 'prd'): Promise<Api | null> {
  const { apiJs } = await resolveConfig(config);
  if (!apiJs) {
    return null;
  }
  const apiJsPath =
    env === 'prd'
      ? path.resolve('dist', `${apiJs.slice(0, -extname(apiJs).length)}.js`)
      : path.resolve('src', apiJs);
  if (!existsSync(apiJsPath)) {
    return null;
  }
  if (apiJsPath.endsWith('.js')) {
    return (await import(pathToFileURL(apiJsPath).toString())).api;
  }
  return (await loadTsModule(apiJsPath)).api;
}

async function loadConfig(): Promise<Config> {
  if (!existsSync('waku.config.ts')) {
    return {};
  }
  return (await loadTsModule('waku.config.ts')).default;
}

async function loadTsModule(filePath: string): Promise<any> {
  const { code } = swc.transformFileSync(filePath, {
    swcrc: false,
    jsc: {
      parser: { syntax: 'typescript' },
      target: 'es2022',
    },
  });

  const temp = path.resolve(`.temp-${randomBytes(8).toString('hex')}.js`);
  try {
    writeFileSync(temp, code);
    return await import(pathToFileURL(temp).toString());
  } finally {
    unlinkSync(temp);
  }
}
