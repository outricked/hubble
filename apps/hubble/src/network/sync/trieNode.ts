import { bytesCompare, HubError } from '@farcaster/utils';
import { blake3 } from '@noble/hashes/blake3';
import { assert } from 'console';
import { TIMESTAMP_LENGTH } from '~/network/sync/syncId';
import { blake3Truncate160, BLAKE3TRUNCATE160_EMPTY_HASH } from '~/utils/crypto';

export const EMPTY_HASH = BLAKE3TRUNCATE160_EMPTY_HASH.toString('hex');

/**
 * A snapshot of the trie at a particular timestamp which can be used to determine if two
 * hubs are in sync
 *
 * @prefix - The prefix (timestamp string) used to generate the snapshot
 * @excludedHashes - The hash of all the nodes excluding the prefix character at every index of the prefix
 * @numMessages - The total number of messages captured in the snapshot (excludes the prefix nodes)
 */
export type TrieSnapshot = {
  prefix: Uint8Array;
  excludedHashes: string[];
  numMessages: number;
};

/**
 * Represents a node in a MerkleTrie. Automatically updates the hashes when items are added,
 * and keeps track of the number of items in the subtree.
 */
class TrieNode {
  private _hash: string;
  private _items: number;
  private _children: Map<number, TrieNode>;
  private _key: Uint8Array | undefined;

  constructor() {
    this._hash = '';
    this._items = 0;
    this._children = new Map();
    this._key = undefined;
  }

  /**
   * Inserts a value into the trie. Returns true if the value was inserted, false if it already existed
   *
   * @param key - The key to insert
   * @param value - The value to insert
   * @param current_index - The index of the current character in the key (only used internally)
   * @returns true if the value was inserted, false if it already existed
   *
   * Recursively traverses the trie by prefix and inserts the value at the end. Updates the hashes for
   * every node that was traversed.
   */
  public insert(key: Uint8Array, current_index = 0): boolean {
    assert(current_index < key.length, 'Key length exceeded');
    if (current_index >= key.length) {
      throw 'Key length exceeded';
    }
    const char = key.at(current_index) as number;

    // Do not compact the timestamp portion of the trie, since it is used to compare snapshots
    if (current_index >= TIMESTAMP_LENGTH && this.isLeaf && !this._key) {
      // Reached a leaf node with no value, insert it
      this._setKeyValue(key);
      this._items += 1;
      return true;
    }

    if (current_index >= TIMESTAMP_LENGTH && this.isLeaf) {
      if (bytesCompare(this._key ?? new Uint8Array(), key) === 0) {
        // If the same key exists, do nothing
        return false;
      }
      // If the key is different, and a value exists, then split the node
      this._splitLeafNode(current_index);
    }

    if (!this._children.has(char)) {
      this._addChild(char);
    }

    // Recurse into a non-leaf node and instruct it to insert the value
    const success = this._children.get(char)?.insert(key, current_index + 1);
    if (success) {
      this._items += 1;
      this._updateHash();
      return true;
    }

    return false;
  }

  /**
   * Deletes a value from the trie by key. Returns true if the value was deleted, false if it didn't exist
   *
   * @param key - The key to delete
   * @param current_index - The index of the current character in the key (only used internally)
   *
   * Ensures that there are no empty nodes after deletion. This is important to make sure the hashes
   * will match exactly with another trie that never had the value (e.g. in another hub).
   */
  public delete(key: Uint8Array, current_index = 0): boolean {
    if (this.isLeaf) {
      if (bytesCompare(this._key ?? new Uint8Array(), key) === 0) {
        this._items -= 1;
        this._setKeyValue(undefined);
        return true;
      } else {
        return false;
      }
    }

    assert(current_index < key.length, 'Key length exceeded2');
    if (current_index >= key.length) {
      throw 'Key length exceeded2';
    }
    const char = key.at(current_index) as number;
    if (!this._children.has(char)) {
      return false;
    }

    const success = this._children.get(char)?.delete(key, current_index + 1);
    if (success) {
      this._items -= 1;
      // Delete the child if it's empty. This is required to make sure the hash will be the same
      // as another trie that doesn't have this node in the first place.
      if (this._children.get(char)?.items === 0) {
        this._children.delete(char);
      }

      if (this._items === 1 && this._children.size === 1 && current_index >= TIMESTAMP_LENGTH) {
        // Compact the node if it has only one child
        const [char, child] = this._children.entries().next().value;
        if (child._key) {
          this._setKeyValue(child._key);
          this._children.delete(char);
        }
      }

      this._updateHash();
      return true;
    }

    return false;
  }

  /**
   * Check if a key exists in the trie.
   * @param key - The key to look for
   * @param current_index - The index of the current character in the key (only used internally)
   */
  public exists(key: Uint8Array, current_index = 0): boolean {
    if (this.isLeaf && bytesCompare(this._key ?? new Uint8Array(), key) === 0) {
      return true;
    }

    assert(current_index < key.length, 'Key length exceeded3');
    if (current_index >= key.length) {
      throw 'Key length exceeded3';
    }
    const char = key.at(current_index) as number;
    if (!this._children.has(char)) {
      return false;
    }

    // NOTE: eslint falsely identifies as `fs.exists`.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return this._children.get(char)?.exists(key, current_index + 1) || false;
  }

  // Generates a snapshot for the current node and below. current_index is the index of the prefix the method
  // is operating on
  public getSnapshot(prefix: Uint8Array, current_index = 0): TrieSnapshot {
    const char = prefix.at(current_index) as number;
    if (current_index === prefix.length - 1) {
      const excludedHash = this._excludedHash(char);
      return {
        prefix: prefix,
        excludedHashes: [excludedHash.hash],
        numMessages: excludedHash.items,
      };
    }

    const innerSnapshot = this._children.get(char)?.getSnapshot(prefix, current_index + 1);
    const excludedHash = this._excludedHash(char);
    return {
      prefix: innerSnapshot?.prefix || prefix.subarray(0, current_index + 1),
      excludedHashes: [excludedHash.hash, ...(innerSnapshot?.excludedHashes || [])],
      numMessages: excludedHash.items + (innerSnapshot?.numMessages || 0),
    };
  }

  public get items(): number {
    return this._items;
  }

  public get hash(): string {
    return this._hash;
  }

  public get isLeaf(): boolean {
    return this._children.size === 0;
  }

  // Only available on leaf nodes
  public get value(): Uint8Array | undefined {
    if (this.isLeaf) {
      return this._key;
    }
    return undefined;
  }

  public getNode(prefix: Uint8Array): TrieNode | undefined {
    if (prefix.length === 0) {
      return this;
    }
    const char = prefix.at(0) as number;
    if (!this._children.has(char)) {
      return undefined;
    }
    return this._children.get(char)?.getNode(prefix.slice(1));
  }

  public get children(): IterableIterator<[number, TrieNode]> {
    return this._children.entries();
  }

  public getAllValues(): Uint8Array[] {
    if (this.isLeaf) {
      return this._key ? [this._key] : [];
    }
    const values: Uint8Array[] = [];
    this._children.forEach((child) => {
      values.push(...child.getAllValues());
    });
    return values;
  }

  public recalculateHash(): Uint8Array {
    let digest;
    if (this.isLeaf) {
      digest = blake3Truncate160(this.value);
    } else {
      const hash = blake3.create({ dkLen: 20 });
      this._children.forEach((child) => {
        hash.update(child.recalculateHash());
      });
      digest = hash.digest();
    }
    if (!this._hash) {
      this._hash = Buffer.from(digest.buffer, digest.byteOffset, digest.byteLength).toString('hex');
    }
    return digest;
  }

  /* Private methods */

  private _excludedHash(char: number): { items: number; hash: string } {
    const hash = blake3.create({ dkLen: 20 });
    let excludedItems = 0;
    this._children.forEach((child, key) => {
      if (key !== char) {
        hash.update(Buffer.from(child.hash, 'hex'));
        excludedItems += child.items;
      }
    });
    const digest = hash.digest();
    return {
      hash: Buffer.from(digest.buffer, digest.byteOffset, digest.byteLength).toString('hex'),
      items: excludedItems,
    };
  }

  private _addChild(char: number) {
    this._children.set(char, new TrieNode());
    // The hash requires the children to be sorted, and sorting on insert/update is cheaper than
    // sorting each time we need to update the hash
    this._children = new Map([...this._children.entries()].sort());
  }

  private _setKeyValue(key: Uint8Array | undefined) {
    // The key is copied to a new Uint8Array to avoid using Buffer's shared memory pool. Since
    // TrieNode are long-lived objects, referencing shared memory pool will prevent them from being
    // freed and leak memory.
    this._key = key === undefined ? undefined : new Uint8Array(key);
    this._updateHash();
  }

  // Splits a leaf node into a non-leaf node by clearing its key/value and adding a child for
  // the next char in its key
  private _splitLeafNode(current_index: number) {
    if (!this._key) {
      // This should never happen, check is here for type safety
      throw new HubError('bad_request', 'Cannot split a leaf node without a key and value');
    }

    assert(current_index < this._key.length, 'Cannot split a leaf node at an index greater than its key length');

    const newChildChar = this._key.at(current_index) as number;
    this._addChild(newChildChar);
    this._children.get(newChildChar)?.insert(this._key, current_index + 1);
    this._setKeyValue(undefined);
  }

  private _updateHash() {
    let digest;
    if (this.isLeaf) {
      digest = blake3Truncate160(this.value);
    } else {
      const hash = blake3.create({ dkLen: 20 });
      this._children.forEach((child) => {
        hash.update(Buffer.from(child.hash, 'hex'));
      });
      digest = hash.digest();
    }
    this._hash = Buffer.from(digest.buffer, digest.byteOffset, digest.byteLength).toString('hex');
  }
}

export { TrieNode };
