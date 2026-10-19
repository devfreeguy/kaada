"use client";

import { StaggeredMenu } from "../../components/ui/staggered-menu";
import { navigationItems } from "./navigation-items";

const items = navigationItems.map(({ label, href }) => ({ label, link: href }));
const socialPlaceholders = [{ label: "X" }, { label: "Instagram" }, { label: "LinkedIn" }];

export function MobileNavigation() {
  return <StaggeredMenu items={items} socialItems={socialPlaceholders} />;
}
