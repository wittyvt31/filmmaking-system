import { resolve } from 'node:path';
import { createFilmieServer } from './server.js';

const server = createFilmieServer({
  dataDirectory: resolve('.filmie'),
  outputDirectory: resolve('renders/web'),
  cacheDirectory: resolve('.cache/production'),
  catalogsDirectory: resolve(process.env['FILMIE_WEB_CATALOGS'] ?? 'examples'),
  webDirectory: resolve('apps/web/dist'),
  allowedHosts: (process.env['FILMIE_WEB_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean),
});
const port = Number(process.env['FILMIE_WEB_PORT'] ?? 4173);
const host = process.env['FILMIE_WEB_HOST'] ?? '127.0.0.1';
server.listen(port, host, () => {
  console.log('Filmie is available at http://127.0.0.1:' + port);
});
