import {
  AmpAddMessage,
  CastAddMessage,
  CastId,
  EventResponse,
  EventType,
  FidsResponse,
  getServer,
  HubInfoResponse,
  HubServiceServer,
  HubServiceService,
  IdRegistryEvent,
  Message,
  MessagesResponse,
  Metadata,
  NameRegistryEvent,
  ReactionAddMessage,
  ReactionType,
  Server as GrpcServer,
  ServerCredentials,
  ServiceError,
  SignerAddMessage,
  status,
  SyncIds,
  TrieNodeMetadataResponse,
  TrieNodeSnapshotResponse,
  UserDataAddMessage,
  VerificationAddEthAddressMessage,
} from '@farcaster/protobufs';
import { HubError } from '@farcaster/utils';
import { APP_NICKNAME, APP_VERSION, HubInterface } from '~/hubble';
import { NodeMetadata } from '~/network/sync/merkleTrie';
import SyncEngine from '~/network/sync/syncEngine';
import Engine from '~/storage/engine';
import { logger } from '~/utils/logger';
import { addressInfoFromParts } from '~/utils/p2p';

export const toServiceError = (err: HubError): ServiceError => {
  let grpcCode: number;
  if (err.errCode === 'unauthenticated') {
    grpcCode = status.UNAUTHENTICATED;
  } else if (err.errCode === 'unauthorized') {
    grpcCode = status.PERMISSION_DENIED;
  } else if (
    err.errCode === 'bad_request' ||
    err.errCode === 'bad_request.parse_failure' ||
    err.errCode === 'bad_request.validation_failure' ||
    err.errCode === 'bad_request.invalid_param' ||
    err.errCode === 'bad_request.conflict' ||
    err.errCode === 'bad_request.duplicate'
  ) {
    grpcCode = status.INVALID_ARGUMENT;
  } else if (err.errCode === 'not_found') {
    grpcCode = status.NOT_FOUND;
  } else if (
    err.errCode === 'unavailable' ||
    err.errCode === 'unavailable.network_failure' ||
    err.errCode === 'unavailable.storage_failure'
  ) {
    grpcCode = status.UNAVAILABLE;
  } else {
    grpcCode = status.UNKNOWN;
  }
  const metadata = new Metadata();
  metadata.set('errCode', err.errCode);
  return Object.assign(err, {
    code: grpcCode,
    details: err.message,
    metadata,
  });
};

export default class Server {
  private hub: HubInterface | undefined;
  private engine: Engine | undefined;
  private syncEngine: SyncEngine | undefined;

  private grpcServer: GrpcServer;
  private port: number;

  constructor(hub?: HubInterface, engine?: Engine, syncEngine?: SyncEngine) {
    this.hub = hub;
    this.engine = engine;
    this.syncEngine = syncEngine;

    this.grpcServer = getServer();
    this.port = 0;
    this.grpcServer.addService(HubServiceService, this.getImpl());
  }

  async start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.grpcServer.bindAsync(`0.0.0.0:${port}`, ServerCredentials.createInsecure(), (err, port) => {
        if (err) {
          reject(err);
        } else {
          this.grpcServer.start();
          this.port = port;

          logger.info({ component: 'gRPC Server', address: this.address }, 'Starting gRPC Server');
          resolve(port);
        }
      });
    });
  }

  async stop(force = false): Promise<void> {
    return new Promise((resolve, reject) => {
      if (force) {
        this.grpcServer.forceShutdown();
        resolve();
      } else {
        this.grpcServer.tryShutdown((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }
    });
  }

  get address() {
    const addr = addressInfoFromParts('0.0.0.0', this.port);
    return addr;
  }

  getImpl = (): HubServiceServer => {
    return {
      getInfo: (call, callback) => {
        const info = HubInfoResponse.create({
          version: APP_VERSION,
          isSynced: !this.syncEngine?.isSyncing(),
          nickname: APP_NICKNAME,
          rootHash: this.syncEngine?.trie.rootHash ?? '',
        });

        callback(null, info);
      },
      getAllSyncIdsByPrefix: (call, callback) => {
        const request = call.request;

        const syncIdsResponse = this.syncEngine?.getAllSyncIdsByPrefix(request.prefix);
        callback(null, SyncIds.create({ syncIds: syncIdsResponse ?? [] }));
      },
      getAllMessagesBySyncIds: async (call, callback) => {
        const request = call.request;

        const messagesResult = await this.engine?.getAllMessagesBySyncIds(request.syncIds);
        messagesResult?.match(
          (messages) => {
            callback(null, MessagesResponse.create({ messages: messages ?? [] }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getSyncMetadataByPrefix: (call, callback) => {
        const toTrieNodeMetadataResponse = (metadata?: NodeMetadata): TrieNodeMetadataResponse => {
          const childrenTrie = [];

          if (!metadata) {
            return TrieNodeMetadataResponse.create({});
          }

          if (metadata.children) {
            for (const [, child] of metadata.children) {
              childrenTrie.push(
                TrieNodeMetadataResponse.create({
                  prefix: child.prefix,
                  numMessages: child.numMessages,
                  hash: child.hash,
                  children: [],
                })
              );
            }
          }

          const metadataResponse = TrieNodeMetadataResponse.create({
            prefix: metadata.prefix,
            numMessages: metadata.numMessages,
            hash: metadata.hash,
            children: childrenTrie,
          });

          return metadataResponse;
        };

        const request = call.request;

        const metadata = this.syncEngine?.getTrieNodeMetadata(request.prefix);
        callback(null, toTrieNodeMetadataResponse(metadata));
      },
      getSyncSnapshotByPrefix: (call, callback) => {
        const request = call.request;

        const snapshot = this.syncEngine?.getSnapshotByPrefix(request.prefix);
        snapshot?.match(
          (snapshot) => {
            const snapshotResponse = TrieNodeSnapshotResponse.create({
              prefix: snapshot.prefix,
              numMessages: snapshot.numMessages,
              rootHash: this.syncEngine?.trie.rootHash ?? '',
              excludedHashes: snapshot.excludedHashes,
            });
            callback(null, snapshotResponse);
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      submitMessage: async (call, callback) => {
        const message = call.request;
        const result = await this.hub?.submitMessage(message, 'rpc');
        result?.match(
          () => {
            callback(null, message);
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      submitIdRegistryEvent: async (call, callback) => {
        const idRegistryEvent = call.request;

        const result = await this.hub?.submitIdRegistryEvent(idRegistryEvent, 'rpc');
        result?.match(
          () => {
            callback(null, idRegistryEvent);
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      submitNameRegistryEvent: async (call, callback) => {
        const nameRegistryEvent = call.request;
        const result = await this.hub?.submitNameRegistryEvent(nameRegistryEvent, 'rpc');
        result?.match(
          () => {
            callback(null, nameRegistryEvent);
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getCast: async (call, callback) => {
        const request = call.request;

        const castAddResult = await this.engine?.getCast(request.fid, request.hash);
        castAddResult?.match(
          (castAdd: CastAddMessage) => {
            callback(null, castAdd);
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getCastsByFid: async (call, callback) => {
        const request = call.request;

        const castsResult = await this.engine?.getCastsByFid(request.fid);
        castsResult?.match(
          (casts: CastAddMessage[]) => {
            callback(null, MessagesResponse.create({ messages: casts }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getCastsByParent: async (call, callback) => {
        const request = call.request;

        const castsResult = await this.engine?.getCastsByParent(request);
        castsResult?.match(
          (casts: CastAddMessage[]) => {
            callback(null, MessagesResponse.create({ messages: casts }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getCastsByMention: async (call, callback) => {
        const request = call.request;

        const castsResult = await this.engine?.getCastsByMention(request.fid);
        castsResult?.match(
          (casts: CastAddMessage[]) => {
            callback(null, MessagesResponse.create({ messages: casts }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getReaction: async (call, callback) => {
        const request = call.request;

        const reactionResult = await this.engine?.getReaction(
          request.fid,
          request.reactionType,
          request.castId ?? CastId.create()
        );
        reactionResult?.match(
          (reaction: ReactionAddMessage) => {
            callback(null, reaction);
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getReactionsByFid: async (call, callback) => {
        const request = call.request;
        const reactionType =
          request.reactionType === ReactionType.REACTION_TYPE_NONE ? undefined : request.reactionType;
        const reactionsResult = await this.engine?.getReactionsByFid(request.fid, reactionType);
        reactionsResult?.match(
          (reactions: ReactionAddMessage[]) => {
            callback(null, MessagesResponse.create({ messages: reactions }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getReactionsByCast: async (call, callback) => {
        const request = call.request;
        const reactionType =
          request.reactionType === ReactionType.REACTION_TYPE_NONE ? undefined : request.reactionType;
        const reactionsResult = await this.engine?.getReactionsByCast(request.castId ?? CastId.create(), reactionType);
        reactionsResult?.match(
          (reactions: ReactionAddMessage[]) => {
            callback(null, MessagesResponse.create({ messages: reactions }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getAmp: async (call, callback) => {
        const request = call.request;

        const ampResult = await this.engine?.getAmp(request.fid, request.targetFid);
        ampResult?.match(
          (amp: AmpAddMessage) => {
            callback(null, amp);
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getAmpsByFid: async (call, callback) => {
        const request = call.request;

        const ampsResult = await this.engine?.getAmpsByFid(request.fid);
        ampsResult?.match(
          (amps: AmpAddMessage[]) => {
            callback(null, MessagesResponse.create({ messages: amps }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getAmpsByUser: async (call, callback) => {
        const request = call.request;

        const ampsResult = await this.engine?.getAmpsByTargetFid(request.fid);
        ampsResult?.match(
          (amps: AmpAddMessage[]) => {
            callback(null, MessagesResponse.create({ messages: amps }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getUserData: async (call, callback) => {
        const request = call.request;

        const userDataResult = await this.engine?.getUserData(request.fid, request.userDataType);
        userDataResult?.match(
          (userData: UserDataAddMessage) => {
            callback(null, userData);
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getUserDataByFid: async (call, callback) => {
        const request = call.request;

        const userDataResult = await this.engine?.getUserDataByFid(request.fid);
        userDataResult?.match(
          (userData: UserDataAddMessage[]) => {
            callback(null, MessagesResponse.create({ messages: userData }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getNameRegistryEvent: async (call, callback) => {
        const request = call.request;

        const nameRegistryEventResult = await this.engine?.getNameRegistryEvent(request.name);
        nameRegistryEventResult?.match(
          (nameRegistryEvent: NameRegistryEvent) => {
            callback(null, nameRegistryEvent);
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getVerification: async (call, callback) => {
        const request = call.request;

        const verificationResult = await this.engine?.getVerification(request.fid, request.address);
        verificationResult?.match(
          (verification: VerificationAddEthAddressMessage) => {
            callback(null, verification);
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getVerificationsByFid: async (call, callback) => {
        const request = call.request;

        const verificationsResult = await this.engine?.getVerificationsByFid(request.fid);
        verificationsResult?.match(
          (verifications: VerificationAddEthAddressMessage[]) => {
            callback(null, MessagesResponse.create({ messages: verifications }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getSigner: async (call, callback) => {
        const request = call.request;

        const signerResult = await this.engine?.getSigner(request.fid, request.signer);
        signerResult?.match(
          (signer: SignerAddMessage) => {
            callback(null, signer);
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getSignersByFid: async (call, callback) => {
        const request = call.request;

        const signersResult = await this.engine?.getSignersByFid(request.fid);
        signersResult?.match(
          (signers: SignerAddMessage[]) => {
            callback(null, MessagesResponse.create({ messages: signers }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getIdRegistryEvent: async (call, callback) => {
        const request = call.request;

        const custodyEventResult = await this.engine?.getIdRegistryEvent(request.fid);
        custodyEventResult?.match(
          (custodyEvent: IdRegistryEvent) => {
            callback(null, custodyEvent);
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getFids: async (call, callback) => {
        const result = await this.engine?.getFids();
        result?.match(
          (fids: number[]) => {
            callback(null, FidsResponse.create({ fids }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getAllCastMessagesByFid: async (call, callback) => {
        const request = call.request;

        const result = await this.engine?.getAllCastMessagesByFid(request.fid);
        result?.match(
          (messages: Message[]) => {
            callback(null, MessagesResponse.create({ messages }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getAllReactionMessagesByFid: async (call, callback) => {
        const request = call.request;

        const result = await this.engine?.getAllReactionMessagesByFid(request.fid);
        result?.match(
          (messages: Message[]) => {
            callback(null, MessagesResponse.create({ messages }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getAllAmpMessagesByFid: async (call, callback) => {
        const request = call.request;

        const result = await this.engine?.getAllAmpMessagesByFid(request.fid);
        result?.match(
          (messages: Message[]) => {
            callback(null, MessagesResponse.create({ messages }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getAllVerificationMessagesByFid: async (call, callback) => {
        const request = call.request;

        const result = await this.engine?.getAllVerificationMessagesByFid(request.fid);
        result?.match(
          (messages: Message[]) => {
            callback(null, MessagesResponse.create({ messages }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getAllSignerMessagesByFid: async (call, callback) => {
        const request = call.request;

        const result = await this.engine?.getAllSignerMessagesByFid(request.fid);
        result?.match(
          (messages: Message[]) => {
            callback(null, MessagesResponse.create({ messages }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      getAllUserDataMessagesByFid: async (call, callback) => {
        const request = call.request;

        const result = await this.engine?.getUserDataByFid(request.fid);
        result?.match(
          (messages: Message[]) => {
            callback(null, MessagesResponse.create({ messages }));
          },
          (err: HubError) => {
            callback(toServiceError(err));
          }
        );
      },
      subscribe: async (stream) => {
        const mergeMessageListener = (message: Message) => {
          const response = EventResponse.create({ type: EventType.EVENT_TYPE_MERGE_MESSAGE, message });
          stream.write(response);
        };

        const pruneMessageListener = (message: Message) => {
          const response = EventResponse.create({ type: EventType.EVENT_TYPE_PRUNE_MESSAGE, message });
          stream.write(response);
        };

        const revokeMessageListener = (message: Message) => {
          const response = EventResponse.create({ type: EventType.EVENT_TYPE_REVOKE_MESSAGE, message });
          stream.write(response);
        };

        const mergeIdRegistryEventListener = (event: IdRegistryEvent) => {
          const response = EventResponse.create({
            type: EventType.EVENT_TYPE_MERGE_ID_REGISTRY_EVENT,
            idRegistryEvent: event,
          });
          stream.write(response);
        };

        const mergeNameRegistryEventListener = (event: NameRegistryEvent) => {
          const response = EventResponse.create({
            type: EventType.EVENT_TYPE_MERGE_NAME_REGISTRY_EVENT,
            nameRegistryEvent: event,
          });
          stream.write(response);
        };

        const { request } = stream;

        // if no type filters are provided, subscribe to all event types
        if (request.eventTypes.length === 0) {
          this.engine?.eventHandler.on('mergeMessage', mergeMessageListener);
          this.engine?.eventHandler.on('pruneMessage', pruneMessageListener);
          this.engine?.eventHandler.on('revokeMessage', revokeMessageListener);
          this.engine?.eventHandler.on('mergeIdRegistryEvent', mergeIdRegistryEventListener);
          this.engine?.eventHandler.on('mergeNameRegistryEvent', mergeNameRegistryEventListener);
        } else {
          for (const eventType of request.eventTypes) {
            if (eventType === EventType.EVENT_TYPE_MERGE_MESSAGE) {
              this.engine?.eventHandler.on('mergeMessage', mergeMessageListener);
            } else if (eventType === EventType.EVENT_TYPE_PRUNE_MESSAGE) {
              this.engine?.eventHandler.on('pruneMessage', pruneMessageListener);
            } else if (eventType === EventType.EVENT_TYPE_REVOKE_MESSAGE) {
              this.engine?.eventHandler.on('revokeMessage', revokeMessageListener);
            } else if (eventType === EventType.EVENT_TYPE_MERGE_ID_REGISTRY_EVENT) {
              this.engine?.eventHandler.on('mergeIdRegistryEvent', mergeIdRegistryEventListener);
            } else if (eventType === EventType.EVENT_TYPE_MERGE_NAME_REGISTRY_EVENT) {
              this.engine?.eventHandler.on('mergeNameRegistryEvent', mergeNameRegistryEventListener);
            }
          }
        }

        stream.on('cancelled', () => {
          stream.destroy();
        });

        stream.on('close', () => {
          this.engine?.eventHandler.off('mergeMessage', mergeMessageListener);
          this.engine?.eventHandler.off('pruneMessage', pruneMessageListener);
          this.engine?.eventHandler.off('revokeMessage', revokeMessageListener);
          this.engine?.eventHandler.off('mergeIdRegistryEvent', mergeIdRegistryEventListener);
          this.engine?.eventHandler.off('mergeNameRegistryEvent', mergeNameRegistryEventListener);
        });

        const readyMetadata = new Metadata();
        readyMetadata.add('status', 'ready');
        stream.sendMetadata(readyMetadata);
      },
    };
  };
}
