import Image from "next/image";
import celoLogo from "../../../assets/partners/celo.webp";
import textileLogo from "../../../assets/partners/textile.webp";
import ripioLogo from "../../../assets/partners/ripio.webp";
import styles from "./real-payments.module.css";

const infrastructure = [
  { name: "Celo", logo: celoLogo, role: "The network your payments run on", coming: false },
  {
    name: "Textile",
    logo: textileLogo,
    role: "Helps change money between currencies",
    coming: false,
  },
  { name: "Ripio", logo: ripioLogo, role: "More ways to pay in local currencies", coming: true },
];

export function PaymentInfrastructure() {
  return (
    <div className={styles.infrastructure}>
      <p className={styles.poweredBy}>The services behind your payments</p>
      <ul className={styles.partners} aria-label="Services behind Kaada payments">
        {infrastructure.map(({ name, logo, role, coming }) => (
          <li key={name}>
            <Image src={logo} alt="" width={64} height={64} className={styles.partnerLogo} />
            <div className={styles.partnerDetails}>
              <div className={styles.partnerName}>
                <h3>{name}</h3>
                {coming && <span>Coming next</span>}
              </div>
              <p>{role}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
