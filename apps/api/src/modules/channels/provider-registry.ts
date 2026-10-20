import type { ChannelProvider } from './channel-provider.js';

/**
 * The channel managers this platform can use. Every connection names its provider (`channel_connections.provider`),
 * and each call goes to that provider's adapter, so adding one (Beds24) never changes how another (Zodomus) works.
 */
export class ProviderRegistry {
  private readonly byId = new Map<string, ChannelProvider>();

  constructor(providers: ChannelProvider[]) {
    if (!providers.length) throw new Error('At least one channel provider is required');
    for (const p of providers) {
      if (this.byId.has(p.id)) throw new Error(`Duplicate channel provider: ${p.id}`);
      this.byId.set(p.id, p);
    }
  }

  /** The original provider (Zodomus); used by the admin integration pages. */
  get primary(): ChannelProvider {
    return this.byId.values().next().value as ChannelProvider;
  }

  get(id: string): ChannelProvider | undefined {
    return this.byId.get(id);
  }

  list(): ChannelProvider[] {
    return [...this.byId.values()];
  }
}
