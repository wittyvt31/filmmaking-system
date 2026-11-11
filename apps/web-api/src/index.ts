import { resolve } from 'node:path';
import { createFilmieServer } from './server.js';

const server = createFilmieServer({
  dataDirectory: resolve('.filmie'),
  outputDirectory: resolve('renders/web'),
  cacheDirectory: resolve('.cache/production'),
  catalogsDirectory: resolve(process.env['FILMIE_WEB_CATALOGS'] ?? 'examples'),
  webDirectory: resolve('apps/web/dist'),
});
const port = Number(process.env['FILMIE_WEB_PORT'] ?? 4173);
server.listen(port, '127.0.0.1', () => {
  console.log('Filmie is available at http://127.0.0.1:' + port);
});
