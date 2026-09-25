import { createServer } from 'node:http';
import { PROJECTS } from './demo-projects';

// Local, self-contained monograms: no CDN, remote image service or frontend write required.
const logos = new Map(Object.entries(PROJECTS).map(([symbol, p]) => [`/logos/${symbol}.svg`,
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#${p.color}"/><text x="64" y="82" text-anchor="middle" font-family="Arial,sans-serif" font-size="48" font-weight="700" fill="#fff">${p.monogram}</text></svg>`]));
createServer((request, response) => {
  const svg = logos.get(new URL(request.url ?? '/', 'http://localhost').pathname);
  response.writeHead(svg ? 200 : 404, { 'content-type': svg ? 'image/svg+xml' : 'text/plain', 'access-control-allow-origin': '*' });
  response.end(svg ?? 'Not found');
}).listen(Number(process.env.ASSETS_PORT ?? 8793), process.env.ASSETS_HOST ?? '127.0.0.1');
