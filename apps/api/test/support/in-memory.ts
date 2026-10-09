import { OPEN_INTENT_STATUSES } from "@kaada/domain";
import type {
  Asset,
  Conversation,
  Identity,
  Intent,
  Message,
  Recipient,
  User,
} from "@kaada/domain";

import type { AgentRepositories, AgentUnitOfWork } from "../../src/core/agent/ports.js";

/**
 * In-memory implementations of the domain repository ports, for fast behaviour tests of the agent
 * core. The unit of work runs transactions one at a time (like a per-conversation lock would) and
 * records whether one is currently open.
 */
export interface InMemoryWorld {
  repositories: AgentRepositories;
  unitOfWork: AgentUnitOfWork;
  /** True while a transaction callback is running. */
  readonly inTransaction: boolean;
  transactions: number;
  users: Map<string, User>;
  intents: Map<string, Intent>;
  messages: Message[];
  recipients: Map<string, Recipient>;
  conversations: Map<string, Conversation>;
  addAsset(asset: Asset): void;
  addUser(user: Partial<User> & { id: string }): User;
  addRecipient(recipient: Partial<Recipient> & { id: string; type: Recipient["type"] }): Recipient;
  addIdentity(
    identity: Partial<Identity> & Pick<Identity, "id" | "userId" | "type" | "externalId">,
  ): Identity;
}

export function createInMemoryWorld(): InMemoryWorld {
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000);

  const assets: Asset[] = [];
  const users = new Map<string, User>();
  const identities: Identity[] = [];
  const conversations = new Map<string, Conversation>();
  const messages: Message[] = [];
  const intents = new Map<string, Intent>();
  const recipients = new Map<string, Recipient>();

  const repositories: AgentRepositories = {
    assets: {
      findById: (id) => Promise.resolve(assets.find((a) => a.id === id) ?? null),
      findBySymbol: (symbol, options) =>
        Promise.resolve(
          assets.filter(
            (a) =>
              a.symbol.toLowerCase() === symbol.toLowerCase() &&
              (options?.chainId === undefined || a.chainId === options.chainId),
          ),
        ),
      findByFiatCode: (code) =>
        Promise.resolve(assets.filter((a) => a.fiatCode?.toLowerCase() === code.toLowerCase())),
      listActive: () => Promise.resolve(assets.filter((a) => a.isActive)),
      listAll: () => Promise.resolve([...assets]),
    },

    users: {
      findById: (id) => Promise.resolve(users.get(id) ?? null),
      findByUsername: (username) =>
        Promise.resolve([...users.values()].find((u) => u.username === username) ?? null),
      create: (input) => {
        const user: User = { ...input, createdAt: stamp(), updatedAt: stamp() };
        users.set(user.id, user);
        return Promise.resolve(user);
      },
      createWithIdentity: ({ user, identity }) => {
        const created: User = { ...user, createdAt: stamp(), updatedAt: stamp() };
        const createdIdentity: Identity = { ...identity, createdAt: stamp(), updatedAt: stamp() };
        users.set(created.id, created);
        identities.push(createdIdentity);
        return Promise.resolve({ user: created, identity: createdIdentity });
      },
    },

    identities: {
      findByExternalId: (type, externalId) =>
        Promise.resolve(
          identities.find((i) => i.type === type && i.externalId === externalId) ?? null,
        ),
      findByUsername: (type, username) =>
        Promise.resolve(
          identities.filter(
            (i) => i.type === type && i.username?.toLowerCase() === username.toLowerCase(),
          ),
        ),
      listForUser: (userId) => Promise.resolve(identities.filter((i) => i.userId === userId)),
      add: (identity) => {
        const created: Identity = { ...identity, createdAt: stamp(), updatedAt: stamp() };
        identities.push(created);
        return Promise.resolve(created);
      },
    },

    conversations: {
      findById: (id) => Promise.resolve(conversations.get(id) ?? null),
      findByExternalId: (channel, externalConversationId) =>
        Promise.resolve(
          [...conversations.values()].find(
            (c) => c.channel === channel && c.externalConversationId === externalConversationId,
          ) ?? null,
        ),
      create: (input) => {
        const conversation: Conversation = { ...input, createdAt: stamp(), updatedAt: stamp() };
        conversations.set(conversation.id, conversation);
        return Promise.resolve(conversation);
      },
      getOrCreateByExternalId: (input) => {
        const existing = [...conversations.values()].find(
          (c) =>
            c.channel === input.channel &&
            c.externalConversationId === input.externalConversationId,
        );
        if (existing) return Promise.resolve(existing);
        const conversation: Conversation = { ...input, createdAt: stamp(), updatedAt: stamp() };
        conversations.set(conversation.id, conversation);
        return Promise.resolve(conversation);
      },
      lockForUpdate: () => Promise.resolve(),
      updateStatus: (id, status) => {
        const current = conversations.get(id);
        if (!current) return Promise.reject(new Error("conversation not found"));
        const updated = { ...current, status, updatedAt: stamp() };
        conversations.set(id, updated);
        return Promise.resolve(updated);
      },
    },

    messages: {
      append: (input) => {
        if (input.externalMessageId !== undefined) {
          const duplicate = messages.find(
            (m) =>
              m.conversationId === input.conversationId &&
              m.externalMessageId === input.externalMessageId,
          );
          if (duplicate) return Promise.resolve({ message: duplicate, created: false });
        }
        const message: Message = { ...input, createdAt: stamp() };
        messages.push(message);
        return Promise.resolve({ message, created: true });
      },
      findReply: (conversationId, inboundMessageId) =>
        Promise.resolve(
          messages.find(
            (m) =>
              m.conversationId === conversationId &&
              m.role === "ASSISTANT" &&
              m.metadata?.["inReplyTo"] === inboundMessageId,
          ) ?? null,
        ),
      listRecent: (conversationId, limit) =>
        Promise.resolve(messages.filter((m) => m.conversationId === conversationId).slice(-limit)),
    },

    intents: {
      create: (input) => {
        const intent: Intent = { ...input, createdAt: stamp(), updatedAt: stamp() };
        intents.set(intent.id, intent);
        return Promise.resolve(intent);
      },
      findById: (id) => Promise.resolve(intents.get(id) ?? null),
      findOpenByConversation: (conversationId) => {
        const open = [...intents.values()]
          .filter(
            (i) =>
              i.conversationId === conversationId &&
              (OPEN_INTENT_STATUSES as readonly string[]).includes(i.status),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return Promise.resolve(open[0] ?? null);
      },
      save: (intent) => {
        const saved: Intent = { ...intent, updatedAt: stamp() };
        intents.set(saved.id, saved);
        return Promise.resolve(saved);
      },
      update: (id, update) => {
        const current = intents.get(id);
        if (!current) return Promise.reject(new Error("intent not found"));
        const saved: Intent = { ...current, ...update, updatedAt: stamp() };
        intents.set(id, saved);
        return Promise.resolve(saved);
      },
    },

    recipients: {
      findById: (id) => Promise.resolve(recipients.get(id) ?? null),
      findByIdentifier: (ownerUserId, type, identifier) =>
        Promise.resolve(
          [...recipients.values()].find(
            (r) => r.ownerUserId === ownerUserId && r.type === type && r.identifier === identifier,
          ) ?? null,
        ),
      listSavedByOwner: (ownerUserId) =>
        Promise.resolve(
          [...recipients.values()].filter((r) => r.ownerUserId === ownerUserId && r.isSaved),
        ),
      create: (input) => {
        const recipient: Recipient = { ...input, createdAt: stamp(), updatedAt: stamp() };
        recipients.set(recipient.id, recipient);
        return Promise.resolve(recipient);
      },
    },
  };

  let depth = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const world: InMemoryWorld = {
    repositories,
    unitOfWork: {
      read: repositories,
      transaction: <T>(work: (repos: AgentRepositories) => Promise<T>): Promise<T> => {
        const run = chain.then(async () => {
          depth += 1;
          world.transactions += 1;
          try {
            return await work(repositories);
          } finally {
            depth -= 1;
          }
        });
        chain = run.catch(() => undefined);
        return run;
      },
    },
    get inTransaction() {
      return depth > 0;
    },
    transactions: 0,
    users,
    intents,
    messages,
    recipients,
    conversations,
    addAsset: (asset) => void assets.push(asset),
    addUser: (partial) => {
      const user: User = { createdAt: stamp(), updatedAt: stamp(), ...partial };
      users.set(user.id, user);
      return user;
    },
    addRecipient: (partial) => {
      const recipient: Recipient = {
        isSaved: true,
        createdAt: stamp(),
        updatedAt: stamp(),
        ...partial,
      };
      recipients.set(recipient.id, recipient);
      return recipient;
    },
    addIdentity: (partial) => {
      const identity: Identity = { createdAt: stamp(), updatedAt: stamp(), ...partial };
      identities.push(identity);
      return identity;
    },
  };
  return world;
}
