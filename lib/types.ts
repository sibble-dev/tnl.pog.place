// Shapes of the files written by scripts/build-data.mjs

export type StatMap = Record<string, number>;

export type ItemGroup = "weapon" | "armor" | "accessory";

export type ItemLevel = {
  damage: { min: number; max: number } | null;
  armor: StatMap; // defense values (armor / accessories)
  shield: { statId: string; value: number } | null;
  main: StatMap; // attack speed / range / block chance etc.
  extra: StatMap; // bonus stats at this item level
};

export type Item = {
  id: string;
  name: string;
  group: ItemGroup;
  type: string; // subCategory: staff, head, ring, ...
  grade: number;
  icon: number; // index into ItemData.icons
  armorCategory: string | null;
  requiredLevel: number | null;
  defaultLevel: string | undefined;
  levels: Record<string, ItemLevel>;
  traits: Record<string, number[]>;
  uniqueTraits: Record<string, number[]>;
  resonance: Record<string, { tiers: number[]; probability: number }>;
  randomGroups: { stat: string; min: number; max: number; probability: number }[][];
  enchantMax: number;
  description: string;
  sellPrice: number | null;
  isExchangeable: boolean | null;
};

export type ItemData = {
  featureN: number;
  icons: string[];
  items: Item[];
};

export type StatFormat = { name: string; format: string; multiplier: number };
export type StatFormats = Record<string, StatFormat>;
