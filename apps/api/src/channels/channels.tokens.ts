/** The ChannelMessageService, or null when no chat channel is configured. */
export const CHANNEL_MESSAGE_SERVICE = Symbol("CHANNEL_MESSAGE_SERVICE");
/** The Telegram adapter, or null unless TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are both set. */
export const TELEGRAM_ADAPTER = Symbol("TELEGRAM_ADAPTER");
/** Tells people how their payments are going, in the chat they asked in. Null when no chat channel is configured. */
export const PAYMENT_STATUS_DISPATCHER = Symbol("PAYMENT_STATUS_DISPATCHER");
/** Kaada's conversational voice (channel-neutral). Always present: without Groq it uses the fixed wording. */
export const CONVERSATION_PRESENTER = Symbol("CONVERSATION_PRESENTER");
/** Repositories for the channel edge. */
export const CHANNEL_REPOSITORIES = Symbol("CHANNEL_REPOSITORIES");
