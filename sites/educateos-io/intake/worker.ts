import { DurableObject } from 'cloudflare:workers';
import { IntakeStore } from './store.mjs';

/** Isolated foundation intake storage. Never bound to a district or the control plane. */
export class InterestIntake extends DurableObject<Record<string, unknown>> {
  private readonly store: IntakeStore;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.store = new IntakeStore(ctx.storage);
  }

  async fetch(request: Request): Promise<Response> {
    // Schedule before processing: storage is never accepted without a retention alarm.
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
    return this.store.fetch(request);
  }

  async alarm(): Promise<void> {
    const more = await this.store.purge(Date.now());
    await this.ctx.storage.setAlarm(Date.now() + (more ? 1000 : 3_600_000));
  }
}
