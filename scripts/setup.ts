import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();
const envExamplePath = path.join(rootDir, '.env.example');
const envPath = path.join(rootDir, '.env');
const dataDir = path.join(rootDir, 'data');

const messages: string[] = [];

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  messages.push(`Created data directory: ${dataDir}`);
} else {
  messages.push(`Data directory already exists: ${dataDir}`);
}

if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
  fs.copyFileSync(envExamplePath, envPath);
  messages.push('Created .env from .env.example');
} else if (fs.existsSync(envPath)) {
  messages.push('.env already exists');
} else {
  messages.push('No .env.example found, skipped .env bootstrap');
}

messages.push('Setup completed without deleting user data.');

for (const message of messages) {
  console.log(`[setup] ${message}`);
}
