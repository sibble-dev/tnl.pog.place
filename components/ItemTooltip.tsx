"use client";

import { useState } from "react";
import { grade, itemKind, questlogUrl, statName, statValue } from "@/lib/format";
import type { Item, StatFormats } from "@/lib/types";
import styles from "./ItemTooltip.module.css";

type Props = {
  item: Item;
  iconUrl: string;
  stats: StatFormats;
  slotLabel: string;
  /** Hover version: no traits / trait resonance, level not editable. */
  compact?: boolean;
};

// Shown first in the base section, in this order; other `main` stats follow.
const BASE_ORDER = ["attack_speed_main_hand", "attack_range_main_hand"];

export default function ItemTooltip({ item, iconUrl, stats, slotLabel, compact = false }: Props) {
  const levelKeys = Object.keys(item.levels).sort((a, b) => Number(a) - Number(b));
  const [level, setLevel] = useState(item.defaultLevel ?? levelKeys.at(-1) ?? "");
  const lv = item.levels[level];
  const g = grade(item.grade);

  const name = (id: string) => statName(stats, id);
  const val = (id: string, v: number) => statValue(stats, id, v);
  const signed = (id: string, v: number) => (v >= 0 ? "+" : "") + val(id, v);

  const mainStats = lv
    ? Object.entries(lv.main).sort(
        ([a], [b]) => (BASE_ORDER.indexOf(a) + 1 || 99) - (BASE_ORDER.indexOf(b) + 1 || 99),
      )
    : [];
  const traits = compact ? [] : Object.entries(item.traits);
  const uniqueTraits = compact ? [] : Object.entries(item.uniqueTraits);
  // Heroic items often have several identical random-stat groups; show each distinct one once
  const randomGroups: { group: Item["randomGroups"][number]; count: number }[] = [];
  for (const group of item.randomGroups) {
    const key = JSON.stringify(group);
    const same = randomGroups.find((g) => JSON.stringify(g.group) === key);
    if (same) same.count++;
    else randomGroups.push({ group, count: 1 });
  }
  const resonance = (compact ? [] : Object.entries(item.resonance)).sort(([, a], [, b]) => b.probability - a.probability);

  return (
    <article className={`${styles.tooltip} ${compact ? styles.compact : ""}`} style={{ "--grade": g.color } as React.CSSProperties}>
      <div className={styles.slot}>{slotLabel}</div>

      <header className={styles.header}>
        <div className={styles.icon}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={iconUrl} alt="" width={72} height={72} />
        </div>
        <div className={styles.titles}>
          <h2 className={styles.name}>{item.name}</h2>
          <div className={styles.kind}>
            {itemKind(item)}
          </div>
          <div className={styles.level}>
            Item Level{" "}
            {levelKeys.length > 1 && !compact ? (
              <select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Item level">
                {levelKeys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            ) : (
              <b>{level}</b>
            )}
          </div>
        </div>
      </header>

      {lv && (lv.damage || mainStats.length > 0 || lv.shield || Object.keys(lv.armor).length > 0) && (
        <section className={styles.section}>
          {lv.damage && (
            <Row label="Base Damage" value={`${lv.damage.min.toLocaleString()} ~ ${lv.damage.max.toLocaleString()}`} strong />
          )}
          {mainStats.map(([id, v]) => (
            <Row key={id} label={name(id)} value={val(id, v)} />
          ))}
          {Object.entries(lv.armor).map(([id, v]) => (
            <Row key={id} label={name(id)} value={val(id, v)} strong />
          ))}
          {lv.shield && <Row label={`Shield ${name(lv.shield.statId)}`} value={val(lv.shield.statId, lv.shield.value)} />}
        </section>
      )}

      {lv && Object.keys(lv.extra).length > 0 && (
        <section className={styles.section}>
          <h3>Bonus Stats</h3>
          {Object.entries(lv.extra).map(([id, v]) => (
            <Row key={id} label={name(id)} value={signed(id, v)} />
          ))}
        </section>
      )}

      {traits.length > 0 && (
        <section className={styles.section}>
          <h3>
            Traits <small>max value</small>
          </h3>
          {traits.map(([id, steps]) => (
            <Row
              key={id}
              label={name(id)}
              value={signed(id, steps.at(-1) ?? 0)}
              title={`Per unlock step: ${steps.map((s) => val(id, s)).join(" → ")}`}
            />
          ))}
        </section>
      )}

      {uniqueTraits.length > 0 && (
        <section className={styles.section}>
          <h3>
            Unique Traits <small>max value</small>
          </h3>
          {uniqueTraits.map(([id, steps]) => (
            <Row key={id} label={name(id)} value={signed(id, steps.at(-1) ?? 0)} />
          ))}
        </section>
      )}

      {randomGroups.map(({ group, count }, i) => (
        <details className={`${styles.section} ${styles.collapsible}`} key={i}>
          <summary>
            <h3>
              Random Stat{count > 1 ? `s ×${count}` : randomGroups.length > 1 ? ` ${i + 1}` : ""}{" "}
              <small>
                {count > 1 ? "each rolls one of" : "one of"} {group.length}
              </small>
            </h3>
          </summary>
          {group.map((o) => (
            <Row
              key={o.stat}
              label={name(o.stat)}
              value={`${val(o.stat, o.min)} ~ ${val(o.stat, o.max)}`}
              note={`${o.probability}%`}
            />
          ))}
        </details>
      ))}

      {resonance.length > 0 && (
        <section className={styles.section}>
          <h3>
            Trait Resonance <small>max tier · chance</small>
          </h3>
          {resonance.map(([id, r]) => (
            <Row key={id} label={name(id)} value={signed(id, r.tiers.at(-1) ?? 0)} note={`${r.probability}%`} />
          ))}
        </section>
      )}

      <section className={`${styles.section} ${styles.footer}`}>
        {item.enchantMax > 0 && <Row label="Max Enchant" value={`+${item.enchantMax}`} />}
        {item.requiredLevel ? <Row label="Required Level" value={String(item.requiredLevel)} /> : null}
        <Row label="Trade" value={item.isExchangeable ? "Tradeable" : "Not tradeable"} />
        {item.sellPrice ? <Row label="Sell Price" value={item.sellPrice.toLocaleString()} /> : null}
        {item.description && <p className={styles.description}>{item.description}</p>}
        <a className={styles.link} href={questlogUrl(item.id)} target="_blank" rel="noopener noreferrer">
          View on questlog.gg ↗
        </a>
      </section>
    </article>
  );
}

function Row({
  label,
  value,
  note,
  title,
  strong,
}: {
  label: string;
  value: string;
  note?: string;
  title?: string;
  strong?: boolean;
}) {
  return (
    <div className={`${styles.row} ${strong ? styles.strong : ""}`} title={title}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>
        {value}
        {note && <span className={styles.note}>{note}</span>}
      </span>
    </div>
  );
}
