import Link from "next/link";
import { IconShieldCheck } from "@tabler/icons-react";
import { publicCommunity } from "../../lib/public-community";
import styles from "./legal.module.css";

export function LegalSupport() {
  return (
    <aside className={styles.support} aria-labelledby="legal-help-title">
      <h2 id="legal-help-title">Questions or a privacy request?</h2>
      <p>Need help? Reach us through the official Kaada Telegram community.</p>
      {publicCommunity.telegram ? (
        <Link href={publicCommunity.telegram}>Open the Kaada community</Link>
      ) : (
        <span className={styles.placeholder} aria-disabled="true">
          Community link coming soon
        </span>
      )}
      <p>
        For an account or privacy request, ask an official moderator how to continue privately. Do
        not post personal account details in a public chat.
      </p>
      <p className={styles.warning}>
        <IconShieldCheck size={24} stroke={1.7} aria-hidden="true" />
        <strong>
          Kaada support will never ask for your private key, Recovery Code, PIN, or authenticator
          code.
        </strong>
      </p>
    </aside>
  );
}
