import { blake3 } from '@noble/hashes/blake3';
import { MerkleTrie } from '~/network/sync/merkleTrie';
import { NetworkFactories } from '~/network/utils/factories';
import { EMPTY_HASH } from './trieNode';

describe('MerkleTrie', () => {
  const trieWithIds = async (timestamps: number[]) => {
    const syncIds = await Promise.all(
      timestamps.map(async (t) => {
        return await NetworkFactories.SyncId.create(undefined, { transient: { date: new Date(t * 1000) } });
      })
    );
    const trie = new MerkleTrie();
    syncIds.forEach((id) => trie.insert(id));
    return trie;
  };

  describe('insert', () => {
    test('succeeds inserting a single item', async () => {
      const trie = new MerkleTrie();
      const syncId = await NetworkFactories.SyncId.create();

      expect(trie.items).toEqual(0);
      expect(trie.rootHash).toEqual('');

      trie.insert(syncId);

      expect(trie.items).toEqual(1);
      expect(trie.rootHash).toBeTruthy();
    });

    test('inserts are idempotent', async () => {
      const syncId1 = await NetworkFactories.SyncId.create();
      const syncId2 = await NetworkFactories.SyncId.create();

      const firstTrie = new MerkleTrie();
      firstTrie.insert(syncId1);
      firstTrie.insert(syncId2);

      const secondTrie = new MerkleTrie();
      secondTrie.insert(syncId2);
      secondTrie.insert(syncId1);

      // Order does not matter
      expect(firstTrie.rootHash).toEqual(secondTrie.rootHash);
      expect(firstTrie.items).toEqual(secondTrie.items);
      expect(firstTrie.rootHash).toBeTruthy();

      firstTrie.insert(syncId2);
      secondTrie.insert(syncId1);

      // Re-adding same item does not change the hash
      expect(firstTrie.rootHash).toEqual(secondTrie.rootHash);
      expect(firstTrie.items).toEqual(secondTrie.items);
      expect(firstTrie.items).toEqual(2);
    });

    test('insert multiple items out of order results in the same root hash', async () => {
      const syncIds = await NetworkFactories.SyncId.createList(25);

      const firstTrie = new MerkleTrie();
      const secondTrie = new MerkleTrie();

      syncIds.forEach((syncId) => firstTrie.insert(syncId));
      const shuffledIds = syncIds.sort(() => 0.5 - Math.random());
      shuffledIds.forEach((syncId) => secondTrie.insert(syncId));

      expect(firstTrie.rootHash).toEqual(secondTrie.rootHash);
      expect(firstTrie.rootHash).toBeTruthy();
      expect(firstTrie.items).toEqual(secondTrie.items);
      expect(firstTrie.items).toEqual(25);
    });
  });

  describe('delete', () => {
    test('deletes an item', async () => {
      const syncId = await NetworkFactories.SyncId.create();

      const trie = new MerkleTrie();
      trie.insert(syncId);
      expect(trie.items).toEqual(1);
      expect(trie.rootHash).toBeTruthy();
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      expect(trie.exists(syncId)).toBeTruthy();

      trie.delete(syncId);
      expect(trie.items).toEqual(0);
      expect(trie.rootHash).toEqual(EMPTY_HASH);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      expect(trie.exists(syncId)).toBeFalsy();
    });

    test('deleting an item that does not exist does not change the trie', async () => {
      const syncId = await NetworkFactories.SyncId.create();
      const trie = new MerkleTrie();
      trie.insert(syncId);

      const rootHashBeforeDelete = trie.rootHash;
      const syncId2 = await NetworkFactories.SyncId.create();
      trie.delete(syncId2);

      const rootHashAfterDelete = trie.rootHash;
      expect(rootHashAfterDelete).toEqual(rootHashBeforeDelete);
      expect(trie.items).toEqual(1);
    });

    test('delete is an exact inverse of insert', async () => {
      const syncId1 = await NetworkFactories.SyncId.create();
      const syncId2 = await NetworkFactories.SyncId.create();

      const trie = new MerkleTrie();
      trie.insert(syncId1);
      const rootHashBeforeDelete = trie.rootHash;
      trie.insert(syncId2);

      trie.delete(syncId2);
      expect(trie.rootHash).toEqual(rootHashBeforeDelete);
    });

    test('trie with a deleted item is the same as a trie with the item never added', async () => {
      const syncId1 = await NetworkFactories.SyncId.create();
      const syncId2 = await NetworkFactories.SyncId.create();

      const firstTrie = new MerkleTrie();
      firstTrie.insert(syncId1);
      firstTrie.insert(syncId2);

      firstTrie.delete(syncId1);

      const secondTrie = new MerkleTrie();
      secondTrie.insert(syncId2);

      expect(firstTrie.rootHash).toEqual(secondTrie.rootHash);
      expect(firstTrie.rootHash).toBeTruthy();
      expect(firstTrie.items).toEqual(secondTrie.items);
      expect(firstTrie.items).toEqual(1);
    });
  });

  test('succeeds with single item', async () => {
    const trie = new MerkleTrie();
    const syncId = await NetworkFactories.SyncId.create();

    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(trie.exists(syncId)).toBeFalsy();

    trie.insert(syncId);

    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(trie.exists(syncId)).toBeTruthy();

    const nonExistingSyncId = await NetworkFactories.SyncId.create();
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(trie.exists(nonExistingSyncId)).toBeFalsy();
  });

  test('test multiple items with delete', async () => {
    const trie = new MerkleTrie();
    const syncIds = await NetworkFactories.SyncId.createList(20);

    // Keep track of start time and memory used
    syncIds.forEach((syncId) => trie.insert(syncId));

    // Delete half of the items
    syncIds.slice(0, syncIds.length / 2).forEach((syncId) => trie.delete(syncId));

    // Check that the items are still there
    syncIds.slice(0, syncIds.length / 2).forEach((syncId) => expect(trie.exists(syncId)).toBeFalsy());
    syncIds.slice(syncIds.length / 2).forEach((syncId) => {
      expect(trie.exists(syncId)).toBeTruthy();
    });
  });

  test('value is always undefined for non-leaf nodes', async () => {
    const trie = new MerkleTrie();
    const syncId = await NetworkFactories.SyncId.create();

    trie.insert(syncId);

    expect(trie.root.value).toBeFalsy();
  });

  describe('getNodeMetadata', () => {
    test('returns undefined if prefix is not present', async () => {
      const syncId = await NetworkFactories.SyncId.create(undefined, { transient: { date: new Date(1665182332000) } });
      const trie = new MerkleTrie();
      trie.insert(syncId);

      expect(trie.getTrieNodeMetadata(Buffer.from('166518234'))).toBeUndefined();
    });

    test('returns the root metadata if the prefix is empty', async () => {
      const syncId = await NetworkFactories.SyncId.create(undefined, { transient: { date: new Date(1665182332000) } });
      const trie = new MerkleTrie();
      trie.insert(syncId);

      const nodeMetadata = trie.getTrieNodeMetadata(new Uint8Array());
      expect(nodeMetadata).toBeDefined();
      expect(nodeMetadata?.numMessages).toEqual(1);
      expect(nodeMetadata?.prefix).toEqual(new Uint8Array());
      expect(nodeMetadata?.children?.size).toEqual(1);
      expect(nodeMetadata?.children?.get(syncId.syncId()[0] as number)).toBeDefined();
    });

    test('returns the correct metadata if prefix is present', async () => {
      const trie = await trieWithIds([1665182332, 1665182343]);
      const nodeMetadata = trie.getTrieNodeMetadata(Buffer.from('16651823'));

      expect(nodeMetadata).toBeDefined();
      expect(nodeMetadata?.numMessages).toEqual(2);
      expect(nodeMetadata?.prefix).toEqual(Buffer.from('16651823'));
      expect(nodeMetadata?.children?.size).toEqual(2);
      expect(nodeMetadata?.children?.get(Buffer.from('3')[0] as number)).toBeDefined();
      expect(nodeMetadata?.children?.get(Buffer.from('4')[0] as number)).toBeDefined();
    });
  });

  describe('getSnapshot', () => {
    test('returns basic information', async () => {
      const trie = await trieWithIds([1665182332, 1665182343]);

      const snapshot = trie.getSnapshot(Buffer.from('1665182343'));
      expect(snapshot.prefix).toEqual(Buffer.from('1665182343'));
      expect(snapshot.numMessages).toEqual(1);
      expect(snapshot.excludedHashes.length).toEqual('1665182343'.length);
    });

    test('returns early when prefix is only partially present', async () => {
      const trie = await trieWithIds([1665182332, 1665182343]);

      const snapshot = trie.getSnapshot(Buffer.from('1677123'));
      expect(snapshot.prefix).toEqual(Buffer.from('167'));
      expect(snapshot.numMessages).toEqual(2);
      expect(snapshot.excludedHashes.length).toEqual('167'.length);
    });

    test('excluded hashes excludes the prefix char at every level', async () => {
      const trie = await trieWithIds([1665182332, 1665182343, 1665182345, 1665182351]);
      let snapshot = trie.getSnapshot(Buffer.from('1665182351'));
      let node = trie.getTrieNodeMetadata(Buffer.from('16651823'));
      // We expect the excluded hash to be the hash of the 3 and 4 child nodes, and excludes the 5 child node
      const expectedHash = Buffer.from(
        blake3
          .create({ dkLen: 20 })
          .update(Buffer.from(node?.children?.get(Buffer.from('3')[0] as number)?.hash || '', 'hex'))
          .update(Buffer.from(node?.children?.get(Buffer.from('4')[0] as number)?.hash || '', 'hex'))
          .digest()
      ).toString('hex');
      expect(snapshot.excludedHashes).toEqual([
        EMPTY_HASH, // 1, these are empty because there are no other children at this level
        EMPTY_HASH, // 6
        EMPTY_HASH, // 6
        EMPTY_HASH, // 5
        EMPTY_HASH, // 1
        EMPTY_HASH, // 8
        EMPTY_HASH, // 2
        EMPTY_HASH, // 3
        expectedHash, // 5 (hash of the 3 and 4 child node hashes)
        EMPTY_HASH, // 1
      ]);

      snapshot = trie.getSnapshot(Buffer.from('1665182343'));
      node = trie.getTrieNodeMetadata(Buffer.from('166518234'));
      const expectedLastHash = Buffer.from(
        blake3(Buffer.from(node?.children?.get(Buffer.from('5')[0] as number)?.hash || '', 'hex'), { dkLen: 20 })
      ).toString('hex');
      node = trie.getTrieNodeMetadata(Buffer.from('16651823'));
      const expectedPenultimateHash = Buffer.from(
        blake3
          .create({ dkLen: 20 })
          .update(Buffer.from(node?.children?.get(Buffer.from('3')[0] as number)?.hash || '', 'hex'))
          .update(Buffer.from(node?.children?.get(Buffer.from('5')[0] as number)?.hash || '', 'hex'))
          .digest()
      ).toString('hex');
      expect(snapshot.excludedHashes).toEqual([
        EMPTY_HASH, // 1
        EMPTY_HASH, // 6
        EMPTY_HASH, // 6
        EMPTY_HASH, // 5
        EMPTY_HASH, // 1
        EMPTY_HASH, // 8
        EMPTY_HASH, // 2
        EMPTY_HASH, // 3
        expectedPenultimateHash, // 4 (hash of the 3 and 5 child node hashes)
        expectedLastHash, // 3 (hash of the 5 child node hash)
      ]);
    });
  });

  test('getAllValues returns all values for child nodes', async () => {
    const trie = await trieWithIds([1665182332, 1665182343, 1665182345]);

    let values = trie.root.getNode(Buffer.from('16651823'))?.getAllValues();
    expect(values?.length).toEqual(3);
    values = trie.root.getNode(Buffer.from('166518233'))?.getAllValues();
    expect(values?.length).toEqual(1);
  });

  describe('getDivergencePrefix', () => {
    test('returns the prefix with the most common excluded hashes', async () => {
      const trie = await trieWithIds([1665182332, 1665182343, 1665182345]);
      const prefixToTest = Buffer.from('1665182343');
      const oldSnapshot = trie.getSnapshot(prefixToTest);
      trie.insert(await NetworkFactories.SyncId.create(undefined, { transient: { date: new Date(1665182353000) } }));

      // Since message above was added at 1665182353, the two tries diverged at 16651823 for our prefix
      let divergencePrefix = trie.getDivergencePrefix(prefixToTest, oldSnapshot.excludedHashes);
      expect(divergencePrefix).toEqual(Buffer.from('16651823'));

      // divergence prefix should be the full prefix, if snapshots are the same
      const currentSnapshot = trie.getSnapshot(prefixToTest);
      divergencePrefix = trie.getDivergencePrefix(prefixToTest, currentSnapshot.excludedHashes);
      expect(divergencePrefix).toEqual(prefixToTest);

      // divergence prefix should empty if excluded hashes are empty
      divergencePrefix = trie.getDivergencePrefix(prefixToTest, []);
      expect(divergencePrefix.length).toEqual(0);

      // divergence prefix should be our prefix if provided hashes are longer
      const with5 = Buffer.concat([prefixToTest, Buffer.from('5')]);
      divergencePrefix = trie.getDivergencePrefix(with5, [...currentSnapshot.excludedHashes, 'different']);
      expect(divergencePrefix).toEqual(prefixToTest);
    });
  });
});
