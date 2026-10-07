import type { Layout } from "./layout";
import type { Box } from "./matcher";
import type { Item, ItemGroup } from "./types";

// Equipment slot positions on the character screen, in pixels of the reference screenshot
// (layout_reference.png, 1501x860). lib/layout.ts finds where the character screen sits in
// another screenshot; slotBox maps these positions through that layout.
export type Slot = {
  id: string;
  label: string;
  short: string; // label drawn on the screenshot box
  group: ItemGroup;
  types?: string[]; // item subCategories this slot accepts (all of the group if omitted)
  cx: number;
  cy: number;
  size: number;
};

const EQ = 66; // equipment circle icon box
const COL_L = 1009;
const COL_R = 1091;
const ROWS = [154, 233, 311, 389, 467, 546, 625];

const eq = (id: string, label: string, short: string, group: ItemGroup, type: string, col: number, row: number): Slot => ({
  id,
  label,
  short,
  group,
  types: [type],
  cx: col,
  cy: ROWS[row],
  size: EQ,
});

export const SLOTS: Slot[] = [
  { id: "main", label: "Weapon I", short: "I", group: "weapon", cx: 473, cy: 225, size: 165 },
  { id: "off", label: "Weapon II", short: "II", group: "weapon", cx: 313, cy: 346, size: 105 },
  eq("head", "Head", "Head", "armor", "head", COL_L, 0),
  eq("cloak", "Cloak", "Cloak", "armor", "cloak", COL_R, 0),
  eq("chest", "Chest", "Chest", "armor", "chest", COL_L, 1),
  eq("hands", "Gloves", "Gloves", "armor", "hands", COL_R, 1),
  eq("legs", "Pants", "Pants", "armor", "legs", COL_L, 2),
  eq("feet", "Boots", "Boots", "armor", "feet", COL_R, 2),
  eq("necklace", "Necklace", "Neck", "accessory", "necklace", COL_L, 3),
  eq("bracelet", "Bracelet", "Brace", "accessory", "bracelet", COL_R, 3),
  eq("ring1", "Ring I", "Ring", "accessory", "ring", COL_L, 4),
  eq("ring2", "Ring II", "Ring", "accessory", "ring", COL_R, 4),
  eq("earring", "Earrings", "Ear", "accessory", "earring", COL_L, 5),
  eq("belt", "Belt", "Belt", "accessory", "belt", COL_R, 5),
  eq("brooch", "Brooch", "Brooch", "accessory", "brooch", COL_R, 6),
];

export const GROUP_LABELS: Record<ItemGroup, string> = {
  weapon: "Weapons",
  armor: "Armor",
  accessory: "Accessories",
};

/** A slot's box in screenshot pixels. */
export function slotBox(slot: Slot, layout: Pick<Layout, "scale" | "tx" | "ty">): Box {
  const size = slot.size * layout.scale;
  return { x: slot.cx * layout.scale + layout.tx - size / 2, y: slot.cy * layout.scale + layout.ty - size / 2, size };
}

/** Icon indices of the items a slot can hold. */
export function slotIcons(slot: Slot, items: Item[]): number[] {
  const set = new Set<number>();
  for (const it of items) {
    if (it.group === slot.group && (!slot.types || slot.types.includes(it.type))) set.add(it.icon);
  }
  return [...set];
}
