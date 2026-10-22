# Component transitions

Motion is already installed as `framer-motion`; these client leaves use that existing package. Text animations live in the separate sibling `text/` folder. See `text/README.md` for SplitText.

Import each component directly:

```tsx
import { SlideTransition } from "@/app/components/animations/components/slide-transition";
import { FadeTransition } from "@/app/components/animations/components/fade-transition";
import { PopTransition } from "@/app/components/animations/components/pop-transition";

<SlideTransition direction="up" distance={32} delay={0.1}>
  <YourCard />
</SlideTransition>

<SlideTransition direction="down"><YourCard /></SlideTransition>
<FadeTransition><YourCard /></FadeTransition>
<PopTransition fromScale={0.9}><YourCard /></PopTransition>
```

- Default trigger: `in-view`, using the shared page Scroll Area, once per mount. `trigger="mount"` starts on mount instead.
- `direction="up"`: enter from below, leave above. `direction="down"`: enter from above, leave below. `distance` is pixels.
- `visible={false}` animates out and then removes the content. Keep the transition component mounted; conditionally unmounting the wrapper itself bypasses its internal presence boundary.
- `duration`, `exitDuration` and `delay` are seconds. Exit has no entrance delay.
- `once={false}` allows scroll reveals to repeat and animate out on leaving the viewport. `amount` controls the visible fraction (`"some"` by default).
- `className`, `style` and `id` apply to the single animated `div`. Do not put structural `li`/`tr` elements inside a `div`; wrap their contents instead. Keep transforms used by a card’s own layout on that card, inside this wrapper.
- Wrappers need the existing `PageScrollArea` provider, supplied by the root layout.
- Content remains visible in server HTML and with JavaScript disabled. Animation is armed after hydration.
- Reduced-motion preference disables movement, scaling, delays and animation duration. Exiting content becomes inert during its exit.

For conditional UI in a client component:

```tsx
<FadeTransition visible={open} trigger="mount" duration={0.35}>
  <YourPanel />
</FadeTransition>
```

The landing page composes these primitives through `marketing/components/landing-motion.tsx`:

- `Reveal` slides/fades/pops content once it crosses 80% of the Scroll Area height. Pixel margins follow viewport height across device sizes.
- `RevealBoundary` observes a static container without changing layout. Its text and nested reveals inherit the same trigger and entrance delay.
- `RevealGroup` and `RevealItem` coordinate a staggered list with one observer. The FAQ and footer never wait for each row to enter individually.
- `HeadingText` uses SplitText; `DescriptionText` uses BlurText with a slight initial delay. Both inherit container reveals, or observe independently when standalone.
- `clipEntrance` clips a transition during entry, then releases overflow for menus and focus rings. The header uses it for its downward entrance.
- The security stack keeps its own scroll transforms; only its content and white illustration cards reveal.
