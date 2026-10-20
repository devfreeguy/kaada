import styles from "./real-payments.module.css";

const infrastructure = [
  { name: "Celo", role: "Settlement & wallet execution", coming: false },
  { name: "Textile", role: "Liquidity & currency routing", coming: false },
  { name: "Ripio", role: "Regional payments & ramps", coming: true },
];

export function PaymentInfrastructure() {
  return (
    <div className={styles.infrastructure}>
      <p className={styles.poweredBy}>Powered by real payment infrastructure</p>
      <ul className={styles.partners} aria-label="Payment infrastructure">
        {infrastructure.map(({ name, role, coming }) => (
          <li key={name}>
            <div className={styles.partnerName}>
              <h3>{name}</h3>
              {coming && <span>Coming next</span>}
            </div>
            <p>{role}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
