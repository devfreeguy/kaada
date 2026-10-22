# Text animations

## BlurText

```tsx
import BlurText from "@/app/components/animations/text/blur-text";

<BlurText text="Ready when you are." effect="blur" direction="bottom" delay={100} />;
```

- Effects: `blur`, `zoom`, `tilt`, `focus`, and `drift`. `direction` accepts top, bottom, left, or right.
- `animateBy="words"` or `letters`; letter animations keep words together when wrapping.
- `staggerFrom` accepts start, center, end, or deterministic random order.
- `trigger="view"` uses the page Scroll Area. `load` plays immediately; `hover` and `click` start readable and replay on interaction, including Enter/Space.
- `delay` is milliseconds between pieces. `stepDuration` and `loopDelay` are seconds. `loop` repeatedly conceals and reveals.
- `blur`, `distance`, `color`, `fromColor`, `focusOnHover`, `threshold`, and `rootMargin` tune the effect. Custom `animationFrom`, `animationTo`, and Motion `easing` override the defaults.
- `onAnimationComplete` runs after each completed reveal. Keep callbacks in client components. Changing the text resets the animation.
- Text keeps normal inline flow and whitespace during the reveal. One-shot blur reveals restore plain text afterward; they do not turn paragraphs into flex layouts.
- Server HTML is readable. Screen readers receive the full text once; reduced motion skips blur, movement, looping, and replay. The landing page uses the shared marketing adapters to inherit parent reveal timing.

## CountUp

```tsx
import CountUp from "@/app/components/animations/text/count-up";

<CountUp to={20000} separator="," prefix="₦" duration={2} />;
<CountUp from={0} to={128} mode="roll" easing="spring" />;
```

- `mode="count"` counts normally; `roll` animates individual digits.
- `trigger="view"` starts inside the shared page Scroll Area; `load` starts on mount. `startWhen` can delay starting until data is ready.
- `direction="down"` counts from `to` back to `from`. Updated targets animate from the current value.
- `format="compact"` uses K/M/B/T. `decimals`, `separator`, `prefix`, and `suffix` control formatting.
- `easing` supports `easeOut`, `linear`, `expo`, and `spring`. `duration` and `delay` are seconds.
- `replayOnHover` also supports Enter/Space. `onStart` and `onEnd` run once per animation; pass callbacks from a client component.
- Server HTML displays the final number. Screen readers receive the final formatted value without repeated digit announcements. Reduced motion settles immediately, including when the preference changes during playback.
- Uses the installed Motion implementation through `framer-motion`; no additional number-animation dependency is needed. The live completed-payment figure uses CountUp after its data arrives; the static currency total stays server-rendered.

## SplitText

Adapted from the React Bits component supplied for Kaada, using GSAP SplitText and `@gsap/react`. Separate from Motion component transitions; landing headings use the shared marketing adapter.

```tsx
import SplitText from "@/app/components/animations/text/split-text";

<SplitText
  tag="h2"
  text="Ready when you are."
  className="font-heading text-5xl text-navy"
  effect="rise"
  splitType="words, chars"
  delay={50}
  duration={1.25}
  trigger="view"
  hoverEffect="wave"
  mask={false}
/>;
```

- Effects: `rise`, `fade`, `blur`, `flip`, `pop`, `skew`, `wave`.
- Split into characters, words or responsive lines. `mask` clips each animated piece. The text prop is plain text, not nested JSX.
- `trigger="view"` reveals once inside the shared page Scroll Area. `load` plays immediately. `hover` and `click` reveal in view first, then replay on interaction. Hover/click text can also be replayed using the keyboard.
- `hoverEffect="lift"` follows the cursor; `wave` sends a ripple through the text.
- `loop` repeatedly conceals and reveals, separated by `loopDelay` seconds.
- `delay` is milliseconds between pieces. `duration` and `loopDelay` are seconds.
- `staggerFrom` supports start, center, end, edges and random.
- `color` inherits by default. `accentColor` briefly colors the pieces before settling to the final text color.
- `from`, `to` and `ease` allow custom GSAP settings. Keep custom objects stable when a parent re-renders frequently.
- `threshold` defaults to 0.1. `rootMargin` accepts one signed distance such as `-100px` or `-10%`, matching the supplied ScrollTrigger behavior.
- `onLetterAnimationComplete` runs once for each text value's first completed reveal, not for every loop or replay. Pass callbacks from client components; keep page files server-rendered.
- Text remains readable in server HTML and without JavaScript. Splitting waits for fonts. Reduced motion skips splitting and interactions; changes to that preference are handled live.
- GSAP supplies an accessible label and hides individual pieces from assistive technology. Cleanup restores the original text and stops this instance's listeners, timers and pointer animation frames.

The root layout already supplies the required `PageScrollArea` provider. Use an existing layout wrapper when you need to constrain the text width.

`SplitText` and `BlurText` accept `startWhen` to gate a container-controlled reveal and `initialDelay` in seconds before the first piece. The shared landing adapters coordinate these automatically.

`restoreAfterReveal` lets one-shot SplitText headings remove their temporary split markup after completion. The landing adapter enables it and uses inline roots to preserve the original baselines and wrapping.

## Lightweight landing text

`text-reveal.tsx` powers landing descriptions with one native browser animation per block. It keeps normal text flow, has no per-word DOM or blur filters, and removes its animation when finished. Inline text fades without a transform so it preserves wrapping. Parent reveal timing, reduced motion, and no-JavaScript fallbacks are retained.

The standalone React Bits BlurText component remains available for deliberate use outside the landing page. The hero uses server-rendered words and CSS keyframes, with no font-ready or hydration gate. Split headings in later sections reveal only after their pieces are prepared.
