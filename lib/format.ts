import type { Item, StatFormats } from "./types";

// Grade ids, names and colours as used by questlog.gg
export const GRADES: Record<number, { name: string; color: string }> = {
  11: { name: "Common", color: "#b7b7b7" },
  21: { name: "Uncommon", color: "#55c677" },
  31: { name: "Rare", color: "#65b0fc" },
  41: { name: "Epic", color: "#a979cb" },
  51: { name: "Heroic", color: "#c67320" },
  61: { name: "Artifact", color: "#f2dd92" },
  71: { name: "Ancient", color: "#f7bf96" },
};

export const grade = (g: number) => GRADES[g] ?? { name: `Grade ${g}`, color: "#b7b7b7" };

// subCategory -> display name
export const ITEM_TYPES: Record<string, string> = {
  sword: "Sword",
  sword2h: "Greatsword",
  bow: "Longbow",
  crossbow: "Crossbow",
  staff: "Staff",
  dagger: "Dagger",
  wand: "Wand",
  spear: "Spear",
  orb: "Orb",
  gauntlet: "Gauntlet",
  head: "Helmet",
  chest: "Chest Armor",
  hands: "Gloves",
  legs: "Pants",
  feet: "Boots",
  cloak: "Cloak",
  necklace: "Necklace",
  bracelet: "Bracelet",
  ring: "Ring",
  earring: "Earrings",
  belt: "Belt",
  brooch: "Brooch",
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** e.g. "Heroic Staff", "Epic Leather Helmet". */
export function itemKind(item: Item): string {
  return [grade(item.grade).name, item.armorCategory && capitalize(item.armorCategory), ITEM_TYPES[item.type] ?? item.type]
    .filter(Boolean)
    .join(" ");
}

export const statName = (stats: StatFormats, id: string) => stats[id]?.name ?? id;

/** Raw API value -> display string, the same way questlog.gg formats it. */
export function statValue(stats: StatFormats, id: string, raw: number): string {
  const f = stats[id] ?? { format: "{0}", multiplier: 1 };
  const v = Math.floor(f.multiplier * raw * 100) / 100;
  return f.format.replace("{0}", v.toLocaleString("en-US"));
}

export const questlogUrl = (id: string) => `https://questlog.gg/throne-and-liberty/en/db/item/${id}`;
