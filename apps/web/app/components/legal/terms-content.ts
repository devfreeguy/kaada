// TODO(founder): Choose the governing law and dispute venue after confirming the legal operator and launch markets.
import type { LegalDocumentContent } from "./legal-types";

export const termsDocument: LegalDocumentContent = {
  path: "/terms",
  title: "Terms of Service",
  description:
    "The conditions for using Kaada, including payment approvals, fees, account security and recovery.",
  intro:
    "These terms explain the conditions for using Kaada. Read them alongside our Privacy Policy and Risk Disclosure before setting up an account or making a payment.",
  sections: [
    {
      id: "acceptance",
      title: "Using Kaada",
      paragraphs: [
        "By using Kaada, you agree to these terms. If you do not agree, do not use the service. “Kaada”, “we” and “us” refer to the service offered under the Kaada name.",
        "You must be at least 18, able to enter a binding agreement and legally allowed to use the service where you are. Do not use Kaada for another person or organization unless you have authority to do so.",
      ],
    },
    {
      id: "service",
      title: "What the service does",
      paragraphs: [
        "Kaada helps you prepare and approve payments through chat and secure account pages. Telegram is the current live channel. Availability depends on your location, the currencies involved, the network and the services needed for a payment.",
        "Kaada is not a bank. A Kaada wallet is not a bank account, and no deposit insurance or guarantee of the value of funds is promised. Kaada does not provide personal investment, legal or tax advice.",
        "Supported countries, currencies and payment options may change. A country or currency appearing on the website does not guarantee every payment combination is available, or that local bank deposits and withdrawals are supported. Planned features, including WhatsApp and Ripio integration, are not promises of current availability.",
      ],
    },
    {
      id: "account",
      title: "Your account and security",
      paragraphs: [
        "Give accurate information, keep your account details current, and use only wallets and payment sources you are authorized to use. Protect your Telegram account, devices and email as well as your Kaada account.",
        "Your passkey or device key controls your wallet. Keep your payment PIN private and never put it in chat. A PIN approves a payment; it is not a replacement for your account key. You are responsible for protecting your credentials and recovery factors.",
        "Kaada does not hold a private wallet key that lets it restore or control your wallet for you. Losing a device, clearing browser storage or losing access to a passkey provider may affect your access.",
      ],
    },
    {
      id: "instructions",
      title: "Messages are instructions, not guarantees",
      paragraphs: [
        "Kaada can misunderstand a message, a recipient name or an amount. A chat response is not a promise that a payment can be made, has been approved or has completed. Ask for clarification if a summary is wrong or unclear.",
        "Before approving, check the recipient, wallet address where shown, currency, amount, fees and the amount the other person is expected to receive. Do not approve a payment that does not match what you want.",
      ],
    },
    {
      id: "approval",
      title: "Reviewing and approving payments",
      paragraphs: [
        "Payments require the approval shown on the secure Kaada page. Depending on the payment and your account, that can involve your passkey, or your payment PIN and device key. Payments that change currencies can require a limited permission for that payment.",
        "Your approval applies to the payment details and limits presented to you. Changed or expired payment details can require a new approval. Keep secure links private and only approve on the official Kaada site.",
        "Kaada can prepare an action and handle technical steps, but you remain responsible for checking and approving it. The service does not promise that every valid instruction can be completed.",
      ],
    },
    {
      id: "rates-fees",
      title: "Prices, quotes and fees",
      paragraphs: [
        "Exchange rates can change between your message, the quote and the time a payment is carried out. A quote may expire or be subject to stated minimum-received or maximum-spend limits. Only the terms actually shown for that quote apply; an estimate is not a fixed-rate guarantee.",
        "Payments may involve exchange costs, provider charges and network fees. Your wallet may need a small amount of CELO for network fees. Those fees can change and may be charged even if an attempted transaction fails. Review the details shown before approving.",
      ],
    },
    {
      id: "finality",
      title: "When a payment is sent",
      paragraphs: [
        "An approval, submission or pending message does not by itself mean that a payment has completed. Network delays, failures or provider checks can affect the result. If the outcome is unclear, check its status before trying again to avoid a duplicate payment.",
        "Confirmed blockchain transactions are generally final. Kaada cannot promise to cancel, reverse or refund a confirmed payment, including a payment to the wrong recipient. Any separate return of money depends on the recipient or relevant provider.",
      ],
    },
    {
      id: "recovery",
      title: "Recovering access",
      paragraphs: [
        "Recovery must be set up before it can help you. It requires your registered email, Recovery Code and a current code from your authenticator app, followed by the waiting period set for your wallet. The standard recovery delay is 72 hours; the period shown during setup or recovery applies.",
        "Recovery replaces your account credential and retires existing permissions. You may need to set a new PIN and set up new recovery details afterward. Kaada cannot guarantee recovery if required factors are lost, checks cannot be completed or the underlying services are unavailable.",
        "Support cannot bypass the required recovery checks. Never share recovery secrets with someone claiming to help.",
      ],
    },
    {
      id: "third-parties",
      title: "Networks and other services",
      paragraphs: [
        "Kaada depends on Telegram, blockchain networks, smart-account software, currency-exchange services, email and other providers. Their availability, rules, fees and restrictions can affect your use. Their separate terms and privacy notices may also apply.",
        "Smart contracts, stablecoins and other emerging technology can fail or behave unexpectedly. Read the separate Risk Disclosure for the main risks. Kaada’s simpler chat experience does not remove them.",
      ],
    },
    {
      id: "prohibited-use",
      title: "What you must not do",
      paragraphs: ["Use Kaada lawfully and respect other people’s rights. You must not:"],
      items: [
        "Use the service for fraud, theft, money laundering, terrorist financing, sanctions evasion or other unlawful activity.",
        "Use someone else’s account, identity, payment source or recovery information without permission.",
        "Mislead people, impersonate Kaada support, exploit errors or try to bypass account, payment or security limits.",
        "Attack the service, interfere with other users, scrape private information or send malicious content.",
        "Use the service in a location or for a transaction where doing so is prohibited by applicable law.",
      ],
    },
    {
      id: "availability",
      title: "Availability, restrictions and stopping use",
      paragraphs: [
        "The MVP may be changed, interrupted or unavailable. We may refuse a request, limit access or suspend the service to address security risks, suspected misuse, legal requirements, maintenance or provider restrictions. We will give notice where required and reasonably possible.",
        "You can stop using Kaada. Ending access does not cancel a submitted transaction, erase a blockchain record or remove duties relating to earlier use. Removing Kaada’s delegated access, where installed, requires the appropriate wallet security action; simply leaving the chat does not do that.",
      ],
    },
    {
      id: "responsibility",
      title: "Service limits and responsibility",
      paragraphs: [
        "To the extent allowed by applicable law, Kaada is provided as available, without a promise of uninterrupted service, error-free software, a particular payment result or successful account recovery. You remain responsible for your payment decisions and any taxes or reporting duties that apply to you.",
        "To the extent permitted by law, Kaada is not liable for indirect or consequential losses, lost profits or losses caused by matters outside its reasonable control. This does not exclude liability for fraud, deliberate misconduct or any responsibility that the law does not allow us to exclude or limit.",
        "Nothing in these terms removes mandatory consumer rights. You may be responsible for losses you cause through fraud, unlawful use or a material breach of these terms, subject to applicable law; this does not make you responsible for Kaada’s own fault.",
      ],
    },
    {
      id: "applicable-law",
      title: "Applicable law and disputes",
      paragraphs: [
        "Mandatory laws that apply to you continue to apply. These terms do not require you to give up rights or protections that cannot lawfully be waived.",
        "If there is a problem, use the community contact process below so we can try to resolve it. Nothing here prevents either party from using a court or authority that has lawful jurisdiction.",
      ],
    },
    {
      id: "changes",
      title: "Changes to these terms",
      paragraphs: [
        "We may update these terms as Kaada changes. The effective and last-updated dates identify this version. We will provide notice of material changes where required by applicable law. If you do not accept updated terms, stop using the affected service.",
        "Our Privacy Policy explains how information is used. Our Risk Disclosure explains risks that you should consider before making payments. Both are linked below.",
      ],
    },
  ],
};
