"use client";

import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { cn } from "cn";
import { IconPlus, IconMinus } from "@tabler/icons-react";

function Accordion({ className, ...props }: AccordionPrimitive.Root.Props) {
  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      className={cn("flex w-full flex-col", className)}
      {...props}
    />
  );
}

function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("border-b border-border last:border-b-0", className)}
      {...props}
    />
  );
}

function AccordionTrigger({ className, children, ...props }: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "group/accordion-trigger flex w-full items-start gap-4 text-left outline-none",
          className,
        )}
        {...props}
      >
        <span
          data-slot="accordion-trigger-icon"
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-navy text-on-dark group-aria-expanded/accordion-trigger:bg-primary group-aria-expanded/accordion-trigger:text-navy"
        >
          <IconPlus size={20} className="group-aria-expanded/accordion-trigger:hidden" />
          <IconMinus size={20} className="hidden group-aria-expanded/accordion-trigger:block" />
        </span>
        {children}
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({ className, children, ...props }: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="overflow-hidden text-sm"
      {...props}
    >
      <div className={cn("[&_a]:underline [&_a]:underline-offset-3", className)}>{children}</div>
    </AccordionPrimitive.Panel>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
