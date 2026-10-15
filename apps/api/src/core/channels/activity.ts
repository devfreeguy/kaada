import type { ChannelAdapter, ChannelTarget } from "./types.js";
import { DEFAULT_LATENCY, classifyInbound, progressText } from "./latency.js";
import type { LatencyPlan, LatencyTimings } from "./latency.js";
import type { InboundChannelMessage } from "./types.js";

/**
 * What a person sees while Kaada works on their message, over any channel. The channel-neutral operations are
 *   setActivity            the channel's own "typing" signal
 *   showTransientStatus    ONE temporary status line
 *   clearTransientStatus   take it away again
 * and each is a no-op where the channel cannot do it (a channel with no typing signal or no way to remove a message simply
 * shows nothing). Telegram implements them with sendChatAction / sendMessage / deleteMessage; another channel maps its own.
 */
export class ActivityChannel {
  private statusId: string | undefined;

  constructor(
    private readonly adapter: ChannelAdapter,
    private readonly target: ChannelTarget,
  ) {}

  setActivity(): void {
    void this.adapter.indicateTyping?.(this.target).catch(() => undefined);
  }

  /** Shows the status and remembers it so it can be cleared. Returns false if it could not be shown. */
  async showTransientStatus(text: string): Promise<boolean> {
    try {
      this.statusId = (await this.adapter.send(this.target, { text })).externalMessageId;
      return true;
    } catch {
      // The status is a courtesy; the answer is what matters.
      return false;
    }
  }

  async clearTransientStatus(): Promise<void> {
    const id = this.statusId;
    this.statusId = undefined;
    if (id) await this.adapter.remove?.(this.target, id).catch(() => undefined);
  }
}

/**
 * The activity of one inbound interaction. Started the moment the message is ours, refined if the interaction turns out to be
 * something else (a button that starts real work), and ALWAYS ended: typing stops, and no status is ever left in the chat.
 */
export interface Activity {
  /** The interaction turned out to be this (a pressed button, once it is resolved). Shows nothing for an instant one. */
  refine(plan: LatencyPlan): void;
  /** Text is appearing as it is written: a temporary status would only get in the way. */
  markStreaming(): void;
  /** The work is done and the reply is about to be shown: take the temporary status away first, so it never sits above the answer. */
  clearStatus(): Promise<void>;
  end(): Promise<void>;
}

export const NO_ACTIVITY: Activity = {
  refine: () => undefined,
  markStreaming: () => undefined,
  clearStatus: () => Promise.resolve(),
  end: () => Promise.resolve(),
};

/**
 * Starts the right activity for an interaction, from its class. Instant interactions start nothing. Typing never waits for the
 * model or a provider. A status appears only for real work (a lookup, a payment being prepared), only after `statusAfterMs`, and
 * only if the reply has not arrived by then.
 */
export function beginActivity(input: {
  adapter: ChannelAdapter;
  message: InboundChannelMessage;
  timings?: Partial<LatencyTimings> | undefined;
  /** Looks like a secret: answered at once (and removed), nothing to wait for. */
  quiet?: boolean;
}): Activity {
  if (input.quiet) return NO_ACTIVITY;
  const timings: LatencyTimings = { ...DEFAULT_LATENCY, ...input.timings };
  const channel = new ActivityChannel(input.adapter, {
    externalConversationId: input.message.externalConversationId,
  });
  const startedAt = Date.now();
  let renew: NodeJS.Timeout | undefined;
  let typingStart: NodeJS.Timeout | undefined;
  let slow: NodeJS.Timeout | undefined;
  let ended = false;
  let cleared = false;

  const startTyping = (): void => {
    if (renew || ended) return;
    channel.setActivity();
    renew = setInterval(() => channel.setActivity(), timings.typingEveryMs);
    renew.unref();
  };

  const armStatus = (task: NonNullable<LatencyPlan["progress"]>): void => {
    if (slow || ended || cleared) return;
    const wait = Math.max(0, timings.statusAfterMs - (Date.now() - startedAt));
    slow = setTimeout(() => {
      void (async () => {
        if (ended || cleared) return;
        const shown = await channel.showTransientStatus(
          progressText(task, input.message.externalEventId),
        );
        // The reply arrived while the status was being sent: take it straight back.
        if (shown && (ended || cleared)) await channel.clearTransientStatus();
      })();
    }, wait);
    slow.unref();
  };

  const apply = (plan: LatencyPlan): void => {
    if (plan.typing) {
      if (timings.typingAfterMs <= 0) startTyping();
      else if (!typingStart) {
        typingStart = setTimeout(startTyping, timings.typingAfterMs);
        typingStart.unref();
      }
    }
    if (plan.progress) armStatus(plan.progress);
  };

  apply(classifyInbound(input.message.content));

  const stop = (): void => {
    if (renew) clearInterval(renew);
    if (typingStart) clearTimeout(typingStart);
    if (slow) clearTimeout(slow);
    renew = undefined;
    typingStart = undefined;
    slow = undefined;
  };

  return {
    refine: apply,
    markStreaming: () => {
      if (slow) clearTimeout(slow);
      slow = undefined;
      cleared = true;
    },
    clearStatus: async () => {
      cleared = true;
      if (slow) clearTimeout(slow);
      slow = undefined;
      await channel.clearTransientStatus();
    },
    end: async () => {
      ended = true;
      stop();
      await channel.clearTransientStatus();
    },
  };
}
