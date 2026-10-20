import type { ReactNode } from "react";
import styles from "./step-chat.module.css";

export function ChatBubble({
  sender = "bot",
  children,
}: {
  sender?: "user" | "bot";
  children: ReactNode;
}) {
  return (
    <div className={`${styles.bubble} ${sender === "user" ? styles.outgoing : styles.incoming}`}>
      <p className={styles.sender}>{sender === "user" ? "You" : "Kaada"}</p>
      {children}
    </div>
  );
}
