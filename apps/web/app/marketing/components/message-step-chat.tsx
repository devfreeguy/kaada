import { ChatBubble } from "./chat-bubble";
import styles from "./step-chat.module.css";

export function MessageStepChat() {
  return (
    <div className={styles.conversation} role="group" aria-label="Example: tell Kaada what to send">
      <ChatBubble>
        <p>Hey, welcome to Kaada.</p>
        <p>Who are we sending money to today?</p>
      </ChatBubble>
      <ChatBubble sender="user">
        <p>Send ₦20,000 to Daniel.</p>
      </ChatBubble>
      <ChatBubble>
        <div className={styles.thinking}>
          <span>Thinking</span>
          <span className={styles.dots} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
      </ChatBubble>
    </div>
  );
}
