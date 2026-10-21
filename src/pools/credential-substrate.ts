import type { GalxShardAccount, ProviderType } from './pool-contracts.js';
import { BroccoliDbTable } from '../storage/memory-table.js';

export interface ShardPersistenceAdapter {
  isShardAuthorityConfigured(): boolean;
  getShards(): GalxShardAccount[];
  getShardsAsync(userId?: string, options?: { requireRemote?: boolean }): Promise<GalxShardAccount[]>;
  saveShard(shard: GalxShardAccount): void;
  saveShardAsync(shard: GalxShardAccount, options?: { requireRemote?: boolean; createOnly?: boolean }): Promise<GalxShardAccount>;
  deleteShard(shardId: string): void;
  deleteShardAsync(shardId: string, options?: { requireRemote?: boolean }): Promise<void>;
  logAudit?(event: string, metadata: Record<string, unknown>, shardId?: string, userId?: string): void;
}

/**
 * In-memory credential registry with optional persistence backing.
 * Accelerated by high-throughput indexed reactive tables.
 */
export class GalxCredentialSubstrate {
  public readonly accountTable: BroccoliDbTable<GalxShardAccount>;
  private readonly persistence?: ShardPersistenceAdapter;
  private readonly retractListeners: Array<(shardId: string) => void> = [];
  private initializationPromise: Promise<void> | null = null;
  private initializationRetryAtMs = 0;
  private lastAuthorityRefreshAtMs = 0;
  private authorityRefreshPromise: Promise<number> | null = null;

  constructor(persistence?: ShardPersistenceAdapter) {
    this.persistence = persistence;

    this.accountTable = new BroccoliDbTable<GalxShardAccount>('credential_substrate_accounts');
    this.accountTable.createIndex('provider');
    this.accountTable.createIndex('status');
    this.accountTable.createIndex('userId');
    this.accountTable.createIndex('shardMode');
    this.accountTable.createIndex('authType');
    this.accountTable.createIndex('permissionRetracted');
    this.accountTable.createSortedIndex('priority');
    this.accountTable.createSortedIndex('weight');
    this.accountTable.createSortedIndex('expiresAtMs');
    this.accountTable.createSortedIndex('createdAtMs');
  }

  public initialize(): void {
    void this.ready().catch(() => {});
  }

  private async initializeFromAuthority(): Promise<void> {
    if (!this.persistence) return;
    const authorityConfigured = this.persistence.isShardAuthorityConfigured();
    const persistedShards = authorityConfigured
      ? await this.persistence.getShardsAsync(undefined, { requireRemote: true })
      : this.persistence.getShards();

    this.accountTable.clear();
    for (const shard of persistedShards) {
      if (!shard.permissionRetracted && shard.status !== 'revoked') {
        this.accountTable.put(shard.id, shard);
      }
    }
    this.lastAuthorityRefreshAtMs = Date.now();
  }

  public async ready(): Promise<void> {
    if (!this.initializationPromise) {
      if (Date.now() < this.initializationRetryAtMs) {
        throw new Error('Shard authority initialization is temporarily unavailable');
      }
      this.initializationPromise = this.initializeFromAuthority().catch((error: unknown) => {
        this.initializationPromise = null;
        this.initializationRetryAtMs = Date.now() + 5000;
        throw error;
      });
    }
    await this.initializationPromise;
  }

  public async refreshFromAuthority(): Promise<number> {
    await this.ready();
    if (!this.persistence) return this.accountTable.count();
    if (this.authorityRefreshPromise) return this.authorityRefreshPromise;

    this.authorityRefreshPromise = (async () => {
      const shards = await this.persistence!.getShardsAsync(undefined, { requireRemote: true });
      this.accountTable.clear();
      for (const shard of shards) {
        if (!shard.permissionRetracted && shard.status !== 'revoked') {
          this.accountTable.put(shard.id, shard);
        }
      }
      this.lastAuthorityRefreshAtMs = Date.now();
      return this.accountTable.count();
    })();

    try {
      return await this.authorityRefreshPromise;
    } finally {
      this.authorityRefreshPromise = null;
    }
  }

  public onRetract(listener: (shardId: string) => void): void {
    this.retractListeners.push(listener);
  }

  public addAccount(account: GalxShardAccount): void {
    const normalized: GalxShardAccount = {
      ...account,
      permissionRetracted: account.permissionRetracted ?? false
    };
    this.accountTable.put(account.id, normalized);
    this.persistence?.saveShard(normalized);
  }

  public async addAccountAsync(
    account: GalxShardAccount,
    options: { requireRemote?: boolean; createOnly?: boolean } = { requireRemote: true }
  ): Promise<void> {
    await this.ready();
    const normalized: GalxShardAccount = {
      ...account,
      permissionRetracted: account.permissionRetracted ?? false
    };
    if (this.persistence) {
      const durableAccount = await this.persistence.saveShardAsync(normalized, options);
      this.accountTable.put(durableAccount.id, durableAccount);
    } else {
      this.accountTable.put(normalized.id, normalized);
    }
  }

  public updateAccount(account: GalxShardAccount): void {
    const normalized: GalxShardAccount = {
      ...account,
      permissionRetracted: account.permissionRetracted ?? false
    };
    this.accountTable.put(account.id, normalized);
    this.persistence?.saveShard(normalized);
  }

  public async updateAccountAsync(
    account: GalxShardAccount,
    options: { requireRemote?: boolean } = { requireRemote: true }
  ): Promise<void> {
    await this.ready();
    const normalized: GalxShardAccount = {
      ...account,
      permissionRetracted: account.permissionRetracted ?? false
    };
    if (this.persistence) {
      const durableAccount = await this.persistence.saveShardAsync(normalized, options);
      this.accountTable.put(durableAccount.id, durableAccount);
    } else {
      this.accountTable.put(normalized.id, normalized);
    }
  }

  public retractAccount(accountId: string, userId: string): boolean {
    this.accountTable.delete(accountId);

    for (const listener of this.retractListeners) {
      try {
        listener(accountId);
      } catch {}
    }

    if (this.persistence) {
      const existing = this.persistence.getShards().find(s => s.id === accountId);
      if (existing) {
        const revokedShard: GalxShardAccount = {
          ...existing,
          status: 'revoked',
          permissionRetracted: true,
          updatedAtMs: Date.now()
        };
        this.persistence.saveShard(revokedShard);
      }
    }
    return true;
  }

  public deleteAccount(accountId: string): boolean {
    this.accountTable.delete(accountId);
    for (const listener of this.retractListeners) {
      try {
        listener(accountId);
      } catch {}
    }
    this.persistence?.deleteShard(accountId);
    return true;
  }

  public getAccount(accountId: string): GalxShardAccount | undefined {
    return this.accountTable.get(accountId) || undefined;
  }

  public listAccounts(userId?: string, provider?: ProviderType): readonly GalxShardAccount[] {
    const all = this.accountTable.query({
      sortBy: 'priority',
      sortOrder: 'desc'
    }) as GalxShardAccount[];

    return all.filter(a => {
      if (a.permissionRetracted === true || a.status === 'revoked') return false;
      if (userId && a.userId !== userId) return false;
      if (provider && a.provider !== provider) return false;
      return true;
    });
  }

  public listPooledAccounts(provider?: ProviderType): readonly GalxShardAccount[] {
    const all = this.accountTable.query({
      where: { shardMode: { $eq: 'pooled' } },
      sortBy: 'priority',
      sortOrder: 'desc'
    }) as GalxShardAccount[];

    return all.filter(a =>
      a.permissionRetracted !== true &&
      a.status !== 'revoked' &&
      a.status !== 'dead' &&
      a.status !== 'paused' &&
      (!provider || a.provider === provider)
    );
  }

  public listUserPrivateShards(userId: string, provider?: ProviderType): readonly GalxShardAccount[] {
    const all = this.accountTable.query({
      where: {
        userId: { $eq: userId },
        shardMode: { $eq: 'private' }
      },
      sortBy: 'priority',
      sortOrder: 'desc'
    }) as GalxShardAccount[];

    return all.filter(a =>
      a.permissionRetracted !== true &&
      a.status !== 'revoked' &&
      (!provider || a.provider === provider)
    );
  }
}

export const NovaCredentialSubstrate = GalxCredentialSubstrate;
export type NovaCredentialSubstrate = GalxCredentialSubstrate;
