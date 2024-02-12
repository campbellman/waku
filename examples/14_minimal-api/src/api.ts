import { defineApi, defineApiHandler } from 'waku/server';

// api handler for start/dev commands
export const api = defineApi(async (honoApp, opts) => {
  const { middlewareHandlers } = opts;

  // Hack: struggled to come up with a RegExp that would match everything except /api
  honoApp.use(':route{^(?!api).*}', ...middlewareHandlers);
  honoApp.use('/', ...middlewareHandlers);

  honoApp.get('/api', (c) => c.json({ hello: 'world' }));
});

// platform specific handling here
export default defineApiHandler(async (honoApp, opts) => {
  const apiApp = api(honoApp, opts);
  return apiApp;
});
