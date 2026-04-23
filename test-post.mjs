import { execFileSync } from 'child_process';

const token = process.env.FLUXER_BOT_TOKEN;
const channelId = '1474838935104294972';

console.log('Testing curl POST to send message...');
console.log(`Token: ${token ? token.substring(0, 20) + '...' : 'MISSING'}`);

try {
  const result = execFileSync('curl.exe', [
    '-s', '-v',
    '--connect-timeout', '5',
    '--max-time', '10',
    '-X', 'POST',
    '-H', `Authorization: Bot ${token}`,
    '-H', 'Content-Type: application/json',
    '-d', '{"content":"Hello from music bot!"}',
    `https://api.fluxer.app/channels/${channelId}/messages`,
  ], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log('Response:', result);
} catch (err) {
  console.log('Error:', err.stderr || err.message);
  if (err.stdout) console.log('Stdout:', err.stdout);
}