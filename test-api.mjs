import { execSync } from 'child_process';

// Test if curl.exe can reach the API (different TLS fingerprint than Node.js)
console.log('--- curl.exe test ---');
try {
  const result = execSync('curl.exe -s -w "%{http_code}" -o NUL https://api.fluxer.app/_health', { encoding: 'utf8', timeout: 10000 });
  console.log(`api.fluxer.app/_health: ${result.trim()}`);
} catch (e) {
  console.log(`api.fluxer.app: ${e.message.substring(0, 200)}`);
}

try {
  const result = execSync('curl.exe -s https://api.fluxer.app/gateway', { encoding: 'utf8', timeout: 10000 });
  console.log(`api.fluxer.app/gateway: ${result.trim()}`);
} catch (e) {
  console.log(`gateway: ${e.message.substring(0, 200)}`);
}

try {
  const result = execSync('curl.exe -s https://api.fluxer.app/_health', { encoding: 'utf8', timeout: 10000 });
  console.log(`health body: ${result.trim()}`);
} catch (e) {
  console.log(`health: ${e.message.substring(0, 200)}`);
}