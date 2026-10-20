import { ChatBubble } from "./chat-bubble";
import styles from "./step-chat.module.css";

export function PaymentStepChat() {
  return (
    <div
      className={styles.conversation}
      role="group"
      aria-label="Example: approve and complete your payment"
    >
      <ChatBubble sender="user">
        <p>I’ve approved it on my secure page.</p>
      </ChatBubble>
      <ChatBubble>
        <p>Approval received. Sending it now.</p>
      </ChatBubble>
      <ChatBubble>
        <p className={styles.successTitle}>
          <svg aria-hidden="true" viewBox="0 0 20 20" width="20" height="20" fill="none">
            <circle cx="10" cy="10" r="9" fill="currentColor" />
            <path
              d="m6 10 2.5 2.5L14 7"
              stroke="var(--navy)"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Payment successful
        </p>
        <p>₦20,000 sent to Daniel.</p>
      </ChatBubble>
    </div>
  );
}
