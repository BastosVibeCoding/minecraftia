/**
 * Client RCON minimal pour les scripts de jeu (bataille de chevaliers, vagues de zombies).
 */
import { Socket } from 'node:net';

/** Client RCON minimal (protocole Source) : une connexion, des commandes l'une après l'autre. */
export class Rcon {
  private socket = new Socket();
  private buffer = Buffer.alloc(0);
  private waiting: ((body: string) => void)[] = [];
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();

  async connect(h: string, p: number, password: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.connect(p, h, () => resolve());
    });
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const len = this.buffer.readInt32LE(0);
        if (this.buffer.length < len + 4) break;
        const body = this.buffer.toString('utf8', 12, len + 2);
        this.buffer = this.buffer.subarray(len + 4);
        this.waiting.shift()?.(body);
      }
    });
    await this.send(3, password);
  }

  private send(type: number, body: string): Promise<string> {
    const payload = Buffer.from(body, 'utf8');
    const packet = Buffer.alloc(payload.length + 14);
    packet.writeInt32LE(payload.length + 10, 0);
    packet.writeInt32LE(this.nextId++, 4);
    packet.writeInt32LE(type, 8);
    payload.copy(packet, 12);
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.socket.write(packet);
    });
  }

  /** Commande serveur ; les appels sont mis en file pour ne jamais se croiser. */
  run(command: string): Promise<string> {
    const next = this.chain.then(() => this.send(2, command));
    this.chain = next.catch(() => undefined);
    return next;
  }
}
