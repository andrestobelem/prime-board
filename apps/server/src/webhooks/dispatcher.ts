// Despachador de webhooks (spec §6): POST JSON firmado con HMAC-SHA256,
// entrega asíncrona con reintentos y backoff. Cola en memoria (MVP).
import type { Database } from "bun:sqlite";
import { now } from "../db/util.ts";
import type { WebhookEventName } from "./events.ts";

export type { WebhookEventName } from "./events.ts";

export interface WebhookRow {
  id: string;
  url: string;
  secret: string;
  events: string;
  enabled: number;
  created_at: string;
}

export interface EventActor {
  id: string;
  name: string;
  type: string;
}

export interface DispatcherOptions {
  /** Esperas entre reintentos (ms). El primer intento es inmediato. */
  retryDelays?: number[];
  fetchFn?: typeof fetch;
  log?: (message: string) => void;
}

export function signPayload(secret: string, body: string): string {
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(body);
  return hasher.digest("hex");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class WebhookDispatcher {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly db: Database,
    private readonly options: DispatcherOptions = {},
  ) {}

  /** Emite un evento a todos los webhooks suscriptos. No bloquea al caller. */
  emit(
    event: WebhookEventName,
    actor: EventActor,
    data: Record<string, unknown>,
    changes?: Record<string, { from: unknown; to: unknown }>,
  ): void {
    const hooks = this.db.query("SELECT * FROM webhooks WHERE enabled = 1").all() as WebhookRow[];
    const subscribed = hooks.filter((hook) => {
      const events = JSON.parse(hook.events) as string[];
      return events.includes("*") || events.includes(event);
    });
    if (subscribed.length === 0) return;

    const body = JSON.stringify({
      event,
      actor: { id: actor.id, name: actor.name, type: actor.type },
      data,
      ...(changes && Object.keys(changes).length > 0 ? { changes } : {}),
      createdAt: now(),
    });

    for (const hook of subscribed) {
      const delivery = this.deliver(hook, body).catch((error) => {
        this.options.log?.(`webhook delivery to ${hook.url} failed: ${error}`);
      });
      this.pending.add(delivery);
      delivery.finally(() => this.pending.delete(delivery));
    }
  }

  /** Espera a que terminen todas las entregas en vuelo (para tests y shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private async deliver(hook: WebhookRow, body: string): Promise<void> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const delays = this.options.retryDelays ?? [1_000, 5_000, 25_000];
    const signature = signPayload(hook.secret, body);

    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        const response = await fetchFn(hook.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-primeboard-signature": signature,
          },
          body,
        });
        if (response.ok) return;
        throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        if (attempt === delays.length) throw error;
        await sleep(delays[attempt]!);
      }
    }
  }
}
