import type { LegalDocumentContent } from "./legal-types";

export const riskDocument: LegalDocumentContent = {
  path: "/risk",
  title: "Risk Disclosure",
  description:
    "Understand the risks of blockchain payments, stablecoins, account keys, fees and recovery when using Kaada.",
  intro:
    "Kaada makes payments easier to use. It does not remove the financial and technical risks behind them. Read this before approving a payment, and only use amounts you can afford to put at risk.",
  sections: [
    {
      id: "payment-finality",
      title: "Payments may not be reversible",
      paragraphs: [
        "Confirmed blockchain payments are generally permanent. A wrong amount, recipient or address can cause a loss that Kaada cannot undo. Confirm the person and payment details before approving.",
        "Do not assume a payment failed because a screen or chat stopped updating. Check the status before sending again. An approval or pending message is not proof that money has arrived.",
      ],
    },
    {
      id: "account-software",
      title: "Smart accounts and software can fail",
      paragraphs: [
        "Your wallet and payments depend on smart-account software and smart contracts: programs that run on a blockchain. Bugs, security weaknesses, configuration mistakes or a compromised service can cause failed payments, lost funds or loss of access.",
        "These are still developing technologies. Testing, reviews and security controls reduce some risks but do not guarantee that every fault has been found.",
      ],
    },
    {
      id: "account-keys",
      title: "Your account keys need protection",
      paragraphs: [
        "Someone with access to your device, passkey, email or Telegram account may be able to misuse parts of the service. Protect your devices and review every approval request. Never share a private key, PIN, Recovery Code or authenticator code.",
        "A browser device key is stored on that browser. Clearing its data, losing the device or using a different browser can remove access to that key. A passkey may depend on your device or passkey provider. Keep recovery ready rather than relying on one way in.",
      ],
    },
    {
      id: "stablecoins",
      title: "A stablecoin can lose value",
      paragraphs: [
        "Some payments use stablecoins: digital tokens intended to follow the value of a currency. That intention is not a guarantee. A token can trade below its intended value, sometimes called losing its peg.",
        "Issuer problems, reserves, withdrawal restrictions, frozen addresses, market conditions or failed software can affect value and access. A token’s name or currency label does not make it a bank deposit or promise that it can always be exchanged for cash. No insurance or reimbursement is promised by Kaada.",
      ],
    },
    {
      id: "exchanges",
      title: "Exchange options and prices can change",
      paragraphs: [
        "Changing currencies depends on other services and available funds. A supported currency does not mean every payment is possible at every moment. There may be no suitable exchange available for your amount or location.",
        "Rates can move, quotes can expire, and the final amount can differ from an earlier estimate within the limits you approved. Check the latest details and any minimum amount to be received before you approve.",
      ],
    },
    {
      id: "network-costs",
      title: "Network fees and delays",
      paragraphs: [
        "Your wallet may need CELO to pay network fees. Fees can rise with demand, and a failed transaction can still cost a network fee. A payment may stop until the wallet has enough for fees.",
        "Network congestion, interruptions or changes to blockchain records before final confirmation can delay or affect a payment. Timing estimates are not guarantees.",
      ],
    },
    {
      id: "providers",
      title: "Other services may go offline",
      paragraphs: [
        "Kaada relies on Telegram, blockchain connections, smart-account services, email delivery and payment or currency-exchange providers. An outage, security incident or change in their rules can interrupt payments, messages, approvals or recovery.",
        "A provider may impose its own checks, limits or restrictions. A future integration shown as coming soon is not a service you can rely on today.",
      ],
    },
    {
      id: "locations-laws",
      title: "Availability depends on location and law",
      paragraphs: [
        "Countries and currencies shown on the website do not guarantee that every service is available to every resident. Cross-border payments can be restricted by provider rules, sanctions or local law.",
        "Rules can change. That may limit access, affect a token or stop a payment option. You are responsible for using Kaada lawfully and for any taxes or reporting obligations that apply to you.",
      ],
    },
    {
      id: "recovery-limits",
      title: "Recovery has limits",
      paragraphs: [
        "Recovery is only available if it was properly set up. It needs your registered email, Recovery Code and authenticator-app code, plus the waiting period set for your wallet. The standard delay is 72 hours; use the period shown for your account.",
        "Losing a required factor can mean losing access. Provider outages or insufficient network funding can also delay recovery. Kaada support cannot skip these checks or guarantee recovery.",
      ],
    },
    {
      id: "safe-use",
      title: "Before you approve",
      paragraphs: [
        "Chat makes it easier to ask for a payment, but Kaada can misunderstand an instruction. The secure approval page is where you check the details. Pause if an amount, recipient, currency or fee is unexpected.",
        "Start with a small amount if you are trying a payment for the first time. Keep account and recovery details private, and do not treat a conversation as a guarantee of value, speed or success. Our Terms of Service set out additional conditions and are linked below.",
      ],
    },
  ],
};
