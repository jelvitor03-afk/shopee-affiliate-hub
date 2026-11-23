import { createHubApp } from './app.js';
import { loadEnvConfig } from './config/env.js';

const config = loadEnvConfig();
const hub = createHubApp(config, {
  startCrons: true,
  autoConnectBaileys: true
});

const server = hub.app.listen(config.port, () => {
  hub.db.addLog(
    'info',
    'server',
    `Shopee Affiliate Hub ativo em http://localhost:${config.port}/admin`
  );
  console.log(`Shopee Affiliate Hub ativo em http://localhost:${config.port}/admin`);
});

function gracefulShutdown(signal: string): void {
  console.log(`Encerrando servidor (${signal})...`);
  hub.close();
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
