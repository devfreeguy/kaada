/** The conversation exists but belongs to a different user. */
export class ConversationAccessError extends Error {
  override readonly name = "ConversationAccessError";
}
