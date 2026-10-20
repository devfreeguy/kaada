"use client";

// Adapted from the React Bits StaggeredMenu source supplied for this project.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { Logo } from "../logo";
import styles from "./staggered-menu.module.css";

type MenuItem = { label: string; link: string; ariaLabel?: string };
type SocialItem = { label: string; link?: string };
type StaggeredMenuProps = {
  items: readonly MenuItem[];
  socialItems?: readonly SocialItem[];
  colors?: readonly string[];
  accentColor?: string;
};

const defaultColors = ["var(--primary)", "var(--orange)"];

export function StaggeredMenu({
  items,
  socialItems = [],
  colors = defaultColors,
  accentColor = "var(--primary)",
}: StaggeredMenuProps) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const icon = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const menuId = useId();

  const closeMenu = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!root.current || !panel.current) return;
    const layers = root.current.querySelectorAll("[data-menu-layer]");
    const labels = root.current.querySelectorAll("[data-menu-label]");
    const numbers = root.current.querySelectorAll("[data-menu-number]");
    const socials = root.current.querySelectorAll("[data-menu-social]");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tl = gsap.timeline();
    if (open) {
      gsap.set(labels, { yPercent: 140, rotate: 10 });
      gsap.set(numbers, { opacity: 0 });
      gsap.set(socials, { y: 25, opacity: 0 });
      tl.to(
        layers,
        {
          xPercent: -100,
          duration: reduced ? 0 : 0.5,
          stagger: reduced ? 0 : 0.07,
          ease: "power4.out",
        },
        0,
      )
        .to(
          panel.current,
          { xPercent: -100, duration: reduced ? 0 : 0.65, ease: "power4.out" },
          reduced ? 0 : 0.15,
        )
        .to(
          labels,
          {
            yPercent: 0,
            rotate: 0,
            duration: reduced ? 0 : 1,
            stagger: reduced ? 0 : 0.1,
            ease: "power4.out",
          },
          reduced ? 0 : 0.25,
        )
        .to(
          numbers,
          { opacity: 1, duration: reduced ? 0 : 0.6, stagger: reduced ? 0 : 0.08 },
          reduced ? 0 : 0.35,
        )
        .to(
          socials,
          {
            y: 0,
            opacity: 1,
            duration: reduced ? 0 : 0.55,
            stagger: reduced ? 0 : 0.08,
            ease: "power3.out",
          },
          reduced ? 0 : 0.42,
        )
        .to(icon.current, { rotate: 225, duration: reduced ? 0 : 0.8, ease: "power4.out" }, 0)
        .to(text.current, { yPercent: -50, duration: reduced ? 0 : 0.5, ease: "power4.out" }, 0)
        .call(() => {
          panel.current?.querySelector<HTMLAnchorElement>("a")?.focus();
        });
    } else if (visible) {
      tl.to(
        [panel.current, ...Array.from(layers)],
        { xPercent: 0, duration: reduced ? 0 : 0.32, ease: "power3.in" },
        0,
      )
        .to(icon.current, { rotate: 0, duration: reduced ? 0 : 0.35, ease: "power3.inOut" }, 0)
        .to(text.current, { yPercent: 0, duration: reduced ? 0 : 0.35, ease: "power3.out" }, 0)
        .call(() => setVisible(false));
    }
    return () => {
      tl.kill();
    };
  }, [open, visible]);

  useEffect(() => {
    if (!open) return;
    const scrollViewport =
      document.querySelector<HTMLElement>("#page-scroll-viewport") ?? document.body;
    const previousOverflow = scrollViewport.style.overflow;
    scrollViewport.style.overflow = "hidden";
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onResize = () => {
      if (desktop.matches) closeMenu();
    };
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
      }
      if (event.key !== "Tab") return;
      const focusable = root.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), a[href]",
      );
      const first = focusable?.[0];
      const last = focusable?.[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    desktop.addEventListener("change", onResize);
    return () => {
      scrollViewport.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      desktop.removeEventListener("change", onResize);
    };
  }, [open, closeMenu]);

  return (
    <div
      ref={root}
      className={styles.root}
      role={open ? "dialog" : undefined}
      aria-modal={open ? true : undefined}
      aria-label={open ? "Navigation menu" : undefined}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        aria-controls={menuId}
        className={styles.toggle}
        onClick={() => {
          if (open) closeMenu();
          else {
            setVisible(true);
            setOpen(true);
          }
        }}
      >
        <span className={styles.textWindow} aria-hidden="true">
          <span ref={text} className={styles.textInner}>
            <span>Menu</span>
            <span>Close</span>
          </span>
        </span>
        <span ref={icon} className={styles.icon} aria-hidden="true">
          <span />
          <span />
        </span>
      </button>
      <div hidden={!visible} className={styles.overlay} aria-hidden={!open} inert={!open}>
        <div className={styles.backdrop} onClick={closeMenu} />
        <div className={styles.drawer}>
          {colors.slice(0, 4).map((color, index) => (
            <div
              key={`${color}-${index}`}
              data-menu-layer
              className={styles.layer}
              style={{ background: color }}
            />
          ))}
          <div ref={panel} id={menuId} className={styles.panel}>
            <div className={styles.logo} aria-hidden="true">
              <Logo inverted />
            </div>
            <nav aria-label="Mobile navigation">
              <ul className={styles.list}>
                {items.map((item, index) => (
                  <li key={item.link} className={styles.itemWrap}>
                    <a
                      href={item.link}
                      aria-label={item.ariaLabel}
                      onClick={closeMenu}
                      className={styles.item}
                    >
                      <span data-menu-label>{item.label}</span>
                      <span
                        data-menu-number
                        className={styles.number}
                        style={{ color: accentColor }}
                        aria-hidden="true"
                      >
                        {String(index + 1).padStart(2, "0")}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            {socialItems.length > 0 && (
              <div className={styles.socials}>
                <p data-menu-social className={styles.socialTitle} style={{ color: accentColor }}>
                  Socials <span>— coming soon</span>
                </p>
                <ul className={styles.socialList}>
                  {socialItems.map((item) => (
                    <li key={item.label} data-menu-social>
                      {item.link ? (
                        <a href={item.link} target="_blank" rel="noopener noreferrer">
                          {item.label}
                        </a>
                      ) : (
                        <span aria-disabled="true" title="Coming soon">
                          {item.label}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
