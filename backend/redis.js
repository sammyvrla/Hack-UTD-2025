import { createClient } from 'redis';

export const pub = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
export const sub = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });

pub.on('error', err => console.error('Redis pub error', err));
sub.on('error', err => console.error('Redis sub error', err));

await pub.connect();
await sub.connect();

export async function publishMetric(metric) {
  await pub.publish('metrics-channel', JSON.stringify(metric));
}
