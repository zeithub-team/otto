/** The services of a project as the Services tab keeps them (browser storage, per project). */
export interface StoredInstance {
  key: string;
  name: string;
  image?: string;
  ports?: Array<{ host: number; container?: number; label?: string }>;
  env?: Record<string, string>;
}

const LABEL: Record<string, string> = {
  postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongodb: 'MongoDB', redis: 'Redis', elasticsearch: 'Elasticsearch',
  rabbitmq: 'RabbitMQ', soketi: 'Soketi (WebSocket)', centrifugo: 'Centrifugo (WebSocket)',
};

export function readStoredInstances(projectId: number): StoredInstance[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(`otto-services:${projectId}`) ?? '{}') as { instances?: StoredInstance[] };
    return Array.isArray(saved.instances) ? saved.instances.filter((i) => i && typeof i.key === 'string') : [];
  } catch {
    return [];
  }
}

/** "PostgreSQL (127.0.0.1:5432), Redis (127.0.0.1:6379)" — what the AI is told about the project's services (no passwords). */
export function describeServices(instances: StoredInstance[]): string {
  return instances
    .filter((i) => i.ports?.[0]?.host)
    .map((i) => `${LABEL[i.key] ?? i.key} (127.0.0.1:${i.ports![0].host})`)
    .join(', ');
}
