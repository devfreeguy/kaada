"use client";

import { Logo } from "../../components/logo";
import { ButtonArrow } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";

const telegramBotUrl = "https://t.me/kaadabot?start=landing";

export function StartWithKaada() {
  return (
    <Dialog>
      <DialogTrigger className="kaada-button kaada-button--secondary mt-3">
        Start with Kaada
        <ButtonArrow />
      </DialogTrigger>
      <DialogContent className="max-w-[520px] gap-7 p-6 sm:p-9">
        <div
          className="flex size-16 items-center justify-center rounded-2xl bg-primary/15"
          aria-hidden="true"
        >
          <Logo showWordmark={false} />
        </div>
        <DialogHeader>
          <p className="text-xs font-bold tracking-[0.16em] text-muted-foreground uppercase">
            Your next move
          </p>
          <DialogTitle className="max-w-sm text-4xl leading-[1.08] uppercase sm:text-5xl">
            Good things start with a chat.
          </DialogTitle>
          <DialogDescription>
            Send money in familiar currencies, right from your chat. Pick where you want to start.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <a
            href={telegramBotUrl}
            className="group flex items-center gap-4 rounded-2xl bg-navy px-5 py-5 text-on-dark transition-colors hover:bg-primary hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary motion-reduce:transition-none"
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-white/15 group-hover:bg-navy/10">
              <svg
                width="25"
                height="25"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="m20.8 3.6-3.1 16c-.2 1.1-.9 1.3-1.8.8l-4.7-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.4-4.8 8.8-8c.4-.4-.1-.6-.6-.3L5.7 13.4 1 11.9c-1-.3-1.1-1 .2-1.5L19.6 3.3c.9-.3 1.6.2 1.2.3Z" />
              </svg>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-bold uppercase sm:text-lg">
                Start on Telegram
              </span>
              <span className="mt-1 block text-sm opacity-75">
                Kaada Bot is live. Let’s make a move.
              </span>
            </span>
            <ButtonArrow />
          </a>
          <button
            type="button"
            disabled
            className="flex w-full cursor-not-allowed items-center gap-4 rounded-2xl border border-border bg-muted/60 px-5 py-5 text-left text-muted-foreground"
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-white">
              <svg
                width="25"
                height="25"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M20.5 11.5a8.5 8.5 0 0 1-12.7 7.4L3 20l1.1-4.8a8.5 8.5 0 1 1 16.4-3.7Z" />
                <path d="M8 7.5c0 4.5 4 8.5 8.5 8.5l.7-2.2-2.5-1-1.1 1.1a9 9 0 0 1-3.5-3.5l1.1-1.1-1-2.5Z" />
              </svg>
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-base font-bold uppercase sm:text-lg">WhatsApp</span>
                <span className="rounded-full bg-background px-2.5 py-1.5 text-[10px] font-bold uppercase">
                  Coming soon
                </span>
              </span>
              <span className="mt-1 block text-sm">Another way to chat is on its way.</span>
            </span>
          </button>
        </div>
        <p className="text-center text-sm text-muted-foreground">
          No new app to learn. Just a conversation.
        </p>
      </DialogContent>
    </Dialog>
  );
}
