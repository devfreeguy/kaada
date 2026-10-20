import { ChatBubble } from "./chat-bubble";
import styles from "./step-chat.module.css";

export function ReviewStepChat() {
  return (
    <div className={styles.conversation} role="group" aria-label="Example: review your payment">
      <ChatBubble>
        <p className={styles.messageTitle}>Sure thing. Let’s review.</p>
        <dl className={styles.details}>
          <div>
            <dt>Payment to</dt>
            <dd>Daniel</dd>
          </div>
          <div>
            <dt>You send</dt>
            <dd>₦20,000</dd>
          </div>
          <div>
            <dt>They receive</dt>
            <dd>About ₦20,000</dd>
          </div>
        </dl>
        <p>Everything look right? Confirm on your secure Kaada page.</p>
        <p className={styles.note}>Never share your PIN in this chat.</p>
        <p className={styles.reviewFooter}>
          Review &amp; authorize payment
          <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none">
            <path
              d="M5 15 15 5M5 5h10v10"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </p>
      </ChatBubble>
    </div>
  );
}
