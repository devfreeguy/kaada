// Product checks: docs/authorization.md, docs/recovery-orchestration.md, docs/database.md, and app/lib/device-key.ts.
import type { LegalDocumentContent } from "./legal-types";

export const privacyDocument: LegalDocumentContent = {
  path: "/privacy",
  title: "Privacy Policy",
  description:
    "How Kaada uses account, chat, payment and security information, and the choices you have.",
  intro:
    "This policy explains what information Kaada uses, why we need it, and what choices you have when you use our website, chat service and account pages.",
  sections: [
    {
      id: "who-we-are",
      title: "Who this policy covers",
      paragraphs: [
        "“Kaada”, “we” and “us” mean the service offered under the Kaada name. This policy covers our website, payment conversations and secure account pages. Other services you use, including Telegram, have their own privacy policies.",
      ],
    },
    {
      id: "information",
      title: "Information we receive",
      paragraphs: [
        "We receive information you provide, information from the channel you use, and information needed to prepare and follow your payments. Only share another person’s details if you have a lawful reason to do so.",
      ],
      items: [
        "Account and channel information: your Telegram user and chat identifiers, any name or username made available to us, account settings, country and home-currency choices.",
        "Chat and payment information: messages, payment instructions, recipient names and wallet addresses, amounts, currencies, quotes, fees, approvals, payment status and transaction records.",
        "Recovery information: your recovery email, email-check records, encrypted authenticator-app secrets, Recovery Code verification information and recovery status.",
        "Security information: public wallet addresses, public passkey or device-key information, security challenges, approval records, session/device information and any device-security evidence used by the service.",
        "Technical and support information: connection information such as IP addresses, request/error logs, and information you choose to share when asking for help.",
      ],
    },
    {
      id: "security-data",
      title: "PINs, keys and recovery details",
      paragraphs: [
        "Your payment PIN is checked on a secure Kaada page. We store a one-way verification value, not the plaintext PIN. Authenticator-app secrets are encrypted in storage so that the service can check the codes used for recovery.",
        "Your Recovery Code is created in your browser. Kaada stores verification information, not the plaintext Recovery Code or its derived private key. Keep your copy somewhere safe.",
        "Kaada does not store your private wallet key on its servers. A passkey is managed by your device or passkey provider. If you use a browser device key, that key is kept locally in the browser’s IndexedDB storage as a non-exportable key. That local storage is different from a server holding your key.",
        "Do not send PINs, private keys, Recovery Codes or authenticator codes in chat or support messages. Secure forms process the information needed for the specific check; support will never ask you to disclose these secrets.",
      ],
    },
    {
      id: "uses",
      title: "Why we use information",
      paragraphs: [
        "We use information to provide the service you request, keep accounts secure, prevent misuse and resolve problems. Where data-protection law requires a legal basis, the basis depends on the purpose: providing the requested service, our legitimate interests in security and reliable operation, compliance with applicable law, or consent where required.",
      ],
      items: [
        "Set up and connect your account, understand your instructions, prepare payment details and request your approval.",
        "Check available payment options, send approved payments and show their status.",
        "Verify account access, limit abuse and fraud, and run the recovery checks you set up.",
        "Answer support requests, investigate errors and improve how the service works.",
        "Meet legal obligations and respond to valid legal requests where applicable.",
      ],
    },
    {
      id: "sharing",
      title: "Services that help Kaada work",
      paragraphs: [
        "We share the information needed to operate the features you use with service providers. These categories include hosting and database services, blockchain and smart-account services, email delivery, language-model services, and services that check currency exchanges or carry out payments.",
        "Telegram processes messages and channel information when you use the Telegram bot. Our language-model integration can process your instructions and selected conversation context to understand requests and prepare replies. Payment providers can receive relevant currency, amount and wallet details to check or carry out a payment.",
        "We may also disclose information where required by law, to protect people or the service, or in connection with a business transfer subject to applicable privacy requirements.",
      ],
    },
    {
      id: "public-records",
      title: "Public blockchain records",
      paragraphs: [
        "Blockchain payments are public. Wallet addresses, amounts, assets, payment timing and other transaction details can be visible to anyone, and may be linked to a person using other information.",
        "Once confirmed, blockchain records generally cannot be changed or deleted by Kaada. Deleting or correcting information in our own systems does not remove a public blockchain record.",
      ],
    },
    {
      id: "browser-storage",
      title: "Cookies and browser storage",
      paragraphs: [
        "The current website does not use non-essential analytics, advertising cookies or similar marketing tracking.",
        "Secure account features use browser storage where needed: a recovery session can be kept in this tab’s sessionStorage, and a browser device key can be kept in IndexedDB. Clearing browser data may remove a device key and affect access to your account. Read the Risk Disclosure before relying on a single device.",
        "If we add optional tracking, we will update the relevant information and request consent where required before using it.",
      ],
    },
    {
      id: "retention",
      title: "How long information is kept",
      paragraphs: [
        "Retention depends on the type of information and why it is needed. Account and conversation information may be kept while providing the service. Payment, approval, fraud-prevention and security records may need to be kept longer to investigate problems, resolve disputes or meet applicable legal duties.",
        "Short-lived links, codes and sessions have expiry times. Expiry ends their use for access; it does not necessarily erase related audit records. Deletion requests are assessed against these needs, and information may be de-identified where deletion is not appropriate. Public blockchain records remain outside Kaada’s control.",
      ],
    },
    {
      id: "security-transfers",
      title: "Security and international processing",
      paragraphs: [
        "Kaada uses measures such as limited access, encrypted storage for selected security secrets, hashed verification values and security checks. No system can promise complete protection from loss, misuse or unauthorized access.",
        "Kaada and the services it uses may process information outside your country, where privacy laws can differ. Any safeguards required by applicable data-protection law must apply to that processing. You may ask about the arrangements relevant to your information through the contact process below.",
      ],
    },
    {
      id: "your-choices",
      title: "Your choices and rights",
      paragraphs: [
        "Depending on the law that applies to you, you may have rights to access or correct your information, request deletion, obtain a copy, restrict certain uses, or withdraw consent where consent is the basis for processing. You may also object to processing based on legitimate interests.",
        "You can ask for help with these requests through the official community contact process below. We may need to verify your identity before acting. Some information must be retained for security, payment records or legal reasons; public blockchain information cannot be erased by Kaada.",
        "You may also have the right to complain to the data-protection authority responsible for your location. Not every right applies to every record or purpose.",
      ],
    },
    {
      id: "automated-tools",
      title: "Automated tools and required information",
      paragraphs: [
        "Kaada uses software and language models to interpret messages, check payment options and apply security limits. A conversation can be misunderstood, and checks can refuse or delay a request. Review the payment details and ask for help if something looks wrong.",
        "Kaada does not treat a model’s interpretation as your payment approval. You must approve through the secure payment flow. If you do not provide information required for account security, payment details or recovery, that feature may not work.",
      ],
    },
    {
      id: "children-changes",
      title: "Age limits and policy changes",
      paragraphs: [
        "Kaada is intended for people aged 18 or older who can lawfully use the service. It is not intended for children. If you believe a child has provided account information, use the contact process below.",
        "We may update this policy as the service changes. The dates at the top identify the current version. Material changes will be communicated as required by applicable law. Use of Kaada is also governed by our Terms of Service, linked below.",
      ],
    },
  ],
};
