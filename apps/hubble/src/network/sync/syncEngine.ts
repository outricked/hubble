import * as protobufs from '@farcaster/protobufs';
import { getFarcasterTime, HubError, HubResult, HubRpcClient } from '@farcaster/utils';
import { err, ok } from 'neverthrow';
import { MerkleTrie, NodeMetadata } from '~/network/sync/merkleTrie';
import { SyncId, timestampToPaddedTimestampPrefix } from '~/network/sync/syncId';
import { TrieSnapshot } from '~/network/sync/trieNode';
import Engine from '~/storage/engine';
import { logger } from '~/utils/logger';

// Number of seconds to wait for the network to "settle" before syncing. We will only
// attempt to sync messages that are older than this time.
const SYNC_THRESHOLD_IN_SECONDS = 10;
const HASHES_PER_FETCH = 50;

const log = logger.child({
  component: 'SyncEngine',
});

class SyncEngine {
  private readonly _trie: MerkleTrie;
  private readonly engine: Engine;
  private _isSyncing = false;

  constructor(engine: Engine) {
    this._trie = new MerkleTrie();
    this.engine = engine;

    this.engine.eventHandler.on(
      'mergeMessage',
      async (message: protobufs.Message, deletedMessages?: protobufs.Message[]) => {
        this.addMessage(message);

        for (const deletedMessage of deletedMessages ?? []) {
          this.removeMessage(deletedMessage);
        }
      }
    );

    // Note: There's no guarantee that the message is actually deleted, because the transaction could fail.
    // This is fine, because we'll just end up syncing the message again. It's much worse to miss a removal and cause
    // the trie to diverge in a way that's not recoverable without reconstructing it from the db.
    // Order of events does not matter. The trie will always converge to the same state.
    this.engine.eventHandler.on('pruneMessage', async (message) => {
      this.removeMessage(message);
    });
    this.engine.eventHandler.on('revokeMessage', async (message) => {
      this.removeMessage(message);
    });
  }

  public async initialize() {
    // TODO: cache the trie to disk, and use this only when the cache doesn't exist
    let processedMessages = 0;
    await this.engine.forEachMessage((message) => {
      this.addMessage(message);
      processedMessages += 1;
      if (processedMessages % 10_000 === 0) {
        log.info({ processedMessages }, 'Initializing sync engine');
      }
    });
    log.info({ processedMessages }, 'Sync engine initialized');
  }

  public isSyncing(): boolean {
    return this._isSyncing;
  }

  /** ---------------------------------------------------------------------------------- */
  /**                                      Sync Methods                                  */
  /** ---------------------------------------------------------------------------------- */

  public shouldSync(excludedHashes: string[]): HubResult<boolean> {
    if (this._isSyncing) {
      log.debug('shouldSync: already syncing');
      return ok(false);
    }

    return this.snapshot.map((ourSnapshot) => {
      const excludedHashesMatch =
        ourSnapshot.excludedHashes.length === excludedHashes.length &&
        // NOTE: `index` is controlled by `every` and so not at risk of object injection.
        // eslint-disable-next-line security/detect-object-injection
        ourSnapshot.excludedHashes.every((value, index) => value === excludedHashes[index]);

      log.debug(`shouldSync: excluded hashes check: ${excludedHashes}`);
      return !excludedHashesMatch;
    });
  }

  async performSync(excludedHashes: string[], rpcClient: HubRpcClient) {
    try {
      this._isSyncing = true;
      await this.snapshot
        .asyncMap(async (ourSnapshot) => {
          const divergencePrefix = this._trie.getDivergencePrefix(ourSnapshot.prefix, excludedHashes);
          log.info({ divergencePrefix, prefix: ourSnapshot.prefix }, 'Divergence prefix');
          const missingIds = await this.fetchMissingHashesByPrefix(divergencePrefix, rpcClient);
          log.info({ missingCount: missingIds.length }, 'Fetched missing hashes');

          // TODO: fetch messages in batches
          await this.fetchAndMergeMessages(missingIds, rpcClient);
          log.info(`Sync complete`);
        })
        .mapErr((error) => {
          log.warn(error, `Error performing sync`);
        });
    } catch (e) {
      log.warn(e, `Error performing sync`);
    } finally {
      this._isSyncing = false;
    }
  }

  public async fetchAndMergeMessages(syncIds: Uint8Array[], rpcClient: HubRpcClient): Promise<boolean> {
    if (syncIds.length === 0) {
      return false;
    }

    let result = true;
    const messagesResult = await rpcClient.getAllMessagesBySyncIds(protobufs.SyncIds.create({ syncIds }));
    await messagesResult.match(
      async (msgs) => {
        await this.mergeMessages(msgs.messages, rpcClient);
      },
      async (err) => {
        // e.g. Node goes down while we're performing the sync. No need to handle it, the next round of sync will retry.
        log.warn(err, `Error fetching messages for sync`);
        result = false;
      }
    );
    return result;
  }

  public async mergeMessages(messages: protobufs.Message[], rpcClient: HubRpcClient): Promise<HubResult<void>[]> {
    const mergeResults: HubResult<void>[] = [];
    // First, sort the messages by timestamp to reduce thrashing and refetching
    messages.sort((a, b) => (a.data?.timestamp || 0) - (b.data?.timestamp || 0));

    // Merge messages sequentially, so we can handle missing users.
    // TODO: Optimize by collecting all failures and retrying them in a batch
    for (const msg of messages) {
      const result = await this.engine.mergeMessage(msg);
      // Unknown user error
      if (
        result.isErr() &&
        result.error.errCode === 'bad_request.validation_failure' &&
        (result.error.message === 'invalid signer' || result.error.message.startsWith('unknown fid'))
      ) {
        log.warn({ fid: msg.data?.fid }, 'Unknown user, fetching custody event');
        const result = await this.syncUserAndRetryMessage(msg, rpcClient);
        mergeResults.push(result);
      } else {
        mergeResults.push(result);
      }
    }

    log.info(
      { messages: mergeResults.length, success: mergeResults.filter((r) => r.isOk()).length },
      'Merged messages'
    );

    return mergeResults;
  }

  async fetchMissingHashesByNode(
    theirNode: NodeMetadata,
    ourNode: NodeMetadata | undefined,
    rpcClient: HubRpcClient
  ): Promise<Uint8Array[]> {
    const missingHashes: Uint8Array[] = [];
    // If the node has fewer than HASHES_PER_FETCH, just fetch them all in go, otherwise,
    // iterate through the node's children and fetch them in batches.
    if (theirNode.numMessages <= HASHES_PER_FETCH) {
      const result = await rpcClient.getAllSyncIdsByPrefix(
        protobufs.TrieNodePrefix.create({ prefix: theirNode.prefix })
      );
      result.match(
        (ids) => {
          missingHashes.push(...ids.syncIds);
        },
        (err) => {
          log.warn(err, `Error fetching ids for prefix ${theirNode.prefix}`);
        }
      );
    } else if (theirNode.children) {
      for (const [theirChildChar, theirChild] of theirNode.children.entries()) {
        // recursively fetch hashes for every node where the hashes don't match
        if (ourNode?.children?.get(theirChildChar)?.hash !== theirChild.hash) {
          missingHashes.push(...(await this.fetchMissingHashesByPrefix(theirChild.prefix, rpcClient)));
        }
      }
    }
    return missingHashes;
  }

  async fetchMissingHashesByPrefix(prefix: Uint8Array, rpcClient: HubRpcClient): Promise<Uint8Array[]> {
    const ourNode = this._trie.getTrieNodeMetadata(prefix);
    const theirNodeResult = await rpcClient.getSyncMetadataByPrefix(protobufs.TrieNodePrefix.create({ prefix }));

    const missingHashes: Uint8Array[] = [];
    await theirNodeResult.match(
      async (theirNode) => {
        missingHashes.push(
          ...(await this.fetchMissingHashesByNode(fromNodeMetadataResponse(theirNode), ourNode, rpcClient))
        );
      },
      async (err) => {
        log.warn(err, `Error fetching metadata for prefix ${prefix}`);
      }
    );
    return missingHashes;
  }

  /** ---------------------------------------------------------------------------------- */
  /**                                      Trie Methods                                  */
  /** ---------------------------------------------------------------------------------- */
  public addMessage(message: protobufs.Message): void {
    this._trie.insert(new SyncId(message));
  }

  public removeMessage(message: protobufs.Message): void {
    this._trie.delete(new SyncId(message));
  }

  public getTrieNodeMetadata(prefix: Uint8Array): NodeMetadata | undefined {
    return this._trie.getTrieNodeMetadata(prefix);
  }

  public getAllSyncIdsByPrefix(prefix: Uint8Array): Uint8Array[] {
    return this._trie.root.getNode(prefix)?.getAllValues() ?? [];
  }

  public get trie(): MerkleTrie {
    return this._trie;
  }

  public getSnapshotByPrefix(prefix?: Uint8Array): HubResult<TrieSnapshot> {
    if (!prefix || prefix.length === 0) {
      return this.snapshot;
    } else {
      return ok(this._trie.getSnapshot(prefix));
    }
  }

  public get snapshot(): HubResult<TrieSnapshot> {
    return this.snapshotTimestamp.map((snapshotTimestamp) => {
      // Ignore the least significant digit when fetching the snapshot timestamp because
      // second resolution is too fine grained, and fall outside sync threshold anyway
      return this._trie.getSnapshot(Buffer.from(timestampToPaddedTimestampPrefix(snapshotTimestamp / 10)));
    });
  }

  // Returns the most recent timestamp in seconds that's within the sync threshold
  // (i.e. highest timestamp that's < current time and timestamp % sync_threshold == 0)
  public get snapshotTimestamp(): HubResult<number> {
    return getFarcasterTime().map((farcasterTime) => {
      const currentTimeInSeconds = Math.floor(farcasterTime);
      return Math.floor(currentTimeInSeconds / SYNC_THRESHOLD_IN_SECONDS) * SYNC_THRESHOLD_IN_SECONDS;
    });
  }

  private async syncUserAndRetryMessage(message: protobufs.Message, rpcClient: HubRpcClient): Promise<HubResult<void>> {
    const fid = message.data?.fid;
    if (!fid) {
      return err(new HubError('bad_request.invalid_param', 'Invalid fid'));
    }

    const custodyEventResult = await rpcClient.getIdRegistryEvent(protobufs.FidRequest.create({ fid }));
    if (custodyEventResult.isErr()) {
      return err(new HubError('unavailable.network_failure', 'Failed to fetch custody event'));
    }

    const custodyResult = await this.engine.mergeIdRegistryEvent(custodyEventResult._unsafeUnwrap());
    if (custodyResult.isErr()) {
      return err(new HubError('unavailable.storage_failure', 'Failed to merge custody event'));
    }

    // Probably not required to fetch the signer messages, but doing it here means
    // sync will complete in one round (prevents messages failing to merge due to missed or out of
    // order signer message)
    const signerMessagesResult = await rpcClient.getAllSignerMessagesByFid(protobufs.FidRequest.create({ fid }));
    if (signerMessagesResult.isErr()) {
      return err(new HubError('unavailable.network_failure', 'Failed to fetch signer messages'));
    }

    const results = await this.engine.mergeMessages(signerMessagesResult._unsafeUnwrap().messages);
    if (results.every((r) => r.isErr())) {
      return err(new HubError('unavailable.storage_failure', 'Failed to merge signer messages'));
    } else {
      // if at least one signer message was merged, retry the original message
      return (await this.engine.mergeMessage(message)).mapErr((e) => {
        log.warn(e, `Failed to merge message type ${message.data?.type}`);
        return new HubError('unavailable.storage_failure', e);
      });
    }
  }
}

const fromNodeMetadataResponse = (response: protobufs.TrieNodeMetadataResponse): NodeMetadata => {
  const children = new Map<number, NodeMetadata>();
  for (let i = 0; i < response.children.length; i++) {
    const child = response.children[i];

    if (child && child.prefix.length > 0) {
      const prefix = child.prefix;
      // Char is the last char of prefix
      const char = prefix[prefix.length - 1] as number;

      children.set(char, {
        numMessages: Number(child?.numMessages),
        prefix,
        hash: child?.hash ?? '',
      });
    }
  }

  return {
    prefix: response.prefix ?? '',
    numMessages: Number(response.numMessages),
    hash: response.hash ?? '',
    children,
  };
};

export default SyncEngine;
