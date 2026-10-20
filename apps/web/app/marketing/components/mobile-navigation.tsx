"use client";

import { StaggeredMenu } from "../../components/ui/staggered-menu";
import { navigationItems } from "./navigation-items";

const socialPlaceholders = [{ label: "X" }, { label: "Instagram" }, { label: "LinkedIn" }];

export function MobileNavigation({ anchorPrefix = "" }: { anchorPrefix?: string }) {
  const items = navigationItems.map(({ label, href }) => ({
    label,
    link: `${anchorPrefix}${href}`,
  }));
  return <StaggeredMenu items={items} socialItems={socialPlaceholders} />;
}
