import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';

const EMBEDDING_DIMENSIONS = 1536;

export interface MockOpenAIConfig {
  port?: number;
  dimensions?: number;
}

export class MockOpenAIServer {
  private server: Server | null = null;
  private port: number;
  private dimensions: number;
  private requestCount = 0;

  constructor(config: MockOpenAIConfig = {}) {
    this.port = config.port ?? 9901;
    this.dimensions = config.dimensions ?? EMBEDDING_DIMENSIONS;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));
      this.server.on('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[MockOpenAI] Listening on :${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  resetRequestCount(): void {
    this.requestCount = 0;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || '/';

    res.setHeader('Content-Type', 'application/json');

    if (url === '/v1/embeddings' && req.method === 'POST') {
      this.requestCount++;
      const body = await this.readBody(req);
      const input = Array.isArray(body.input) ? body.input : [body.input];

      const data = input.map((text: string, i: number) => ({
        object: 'embedding',
        index: i,
        embedding: this.deterministicVector(text),
      }));

      res.writeHead(200);
      res.end(
        JSON.stringify({
          object: 'list',
          data,
          model: body.model || 'text-embedding-3-small',
          usage: { prompt_tokens: 10, total_tokens: 10 },
        }),
      );
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: { message: `Unknown endpoint: ${url}` } }));
    }
  }

  private deterministicVector(text: string): number[] {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }

    const vec = new Array(this.dimensions);
    for (let i = 0; i < this.dimensions; i++) {
      hash = ((hash * 1103515245 + 12345) & 0x7fffffff);
      vec[i] = (hash / 0x7fffffff) * 2 - 1;
    }

    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
    return vec.map((v: number) => v / norm);
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      });
    });
  }
}
