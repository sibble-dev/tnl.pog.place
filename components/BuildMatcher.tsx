"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Layout } from "@/lib/layout";
import type { Box, SlotMatch } from "@/lib/matcher";
import type { WorkerRequest, WorkerResponse } from "@/lib/match.worker";
import { GROUP_LABELS, SLOTS, slotBox, slotIcons, type Slot } from "@/lib/slots";
import { grade } from "@/lib/format";
import type { Item, ItemData, ItemGroup, StatFormats } from "@/lib/types";
import ItemTooltip from "./ItemTooltip";
import styles from "./BuildMatcher.module.css";

type SlotState = {
  status: "idle" | "matching" | "done" | "error";
  match?: SlotMatch;
  icon?: number; // selected icon (defaults to best candidate)
  itemId?: string; // selected item among those sharing the icon
  error?: string;
};

type LoadedImage = { url: string; width: number; height: number };

const MIN_BOX = 16;
// A top match this far ahead of the runner-up is treated as confident.
const CONFIDENT_MARGIN = 0.05;
const GROUPS: ItemGroup[] = ["weapon", "armor", "accessory"];

const idleSlots = () => Object.fromEntries(SLOTS.map((s) => [s.id, { status: "idle" }])) as Record<string, SlotState>;

export default function BuildMatcher() {
  const [data, setData] = useState<ItemData | null>(null);
  const [stats, setStats] = useState<StatFormats>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workerReady, setWorkerReady] = useState(false);
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [boxes, setBoxes] = useState<Record<string, Box> | null>(null);
  const [slots, setSlots] = useState<Record<string, SlotState>>(idleSlots);
  const [dragOver, setDragOver] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const requestIds = useRef<Record<string, number>>({});
  const nextRequestId = useRef(1);
  const imageId = useRef(0);
  const pendingAuto = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Load data + start the worker
  useEffect(() => {
    const worker = new Worker(new URL("../lib/match.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === "ready") setWorkerReady(true);
      else if (msg.type === "layout") {
        if (msg.imageId !== imageId.current) return; // an older screenshot
        setLayout(msg.layout);
        setBoxes(layoutBoxes(msg.layout));
        pendingAuto.current = true;
      } else if (msg.type === "result") {
        if (requestIds.current[msg.slot] !== msg.requestId) return; // superseded
        const top = msg.match.candidates[0];
        setSlots((s) => ({ ...s, [msg.slot]: { status: "done", match: msg.match, icon: top?.icon } }));
      } else if (msg.type === "error") {
        const slot = Object.entries(requestIds.current).find(([, id]) => id === msg.requestId)?.[0];
        if (slot) setSlots((s) => ({ ...s, [slot]: { status: "error", error: msg.message } }));
        else setLoadError(msg.message);
      }
    };

    Promise.all([
      fetch("/data/items.json").then((r) => r.json() as Promise<ItemData>),
      fetch("/data/stats.json").then((r) => r.json() as Promise<StatFormats>),
      fetch("/data/features.bin").then((r) => r.arrayBuffer()),
      fetch("/data/layout.bin").then((r) => r.arrayBuffer()),
    ])
      .then(([items, statFormats, features, layoutTpl]) => {
        setData(items);
        setStats(statFormats);
        const init: WorkerRequest = { type: "init", features, n: items.featureN, layout: layoutTpl };
        worker.postMessage(init, [features, layoutTpl]);
      })
      .catch((err) => setLoadError(`Could not load item data: ${err}`));

    return () => worker.terminate();
  }, []);

  const itemsByIcon = useMemo(() => {
    const map = new Map<number, Item[]>();
    for (const it of data?.items ?? []) {
      const list = map.get(it.icon) ?? [];
      list.push(it);
      map.set(it.icon, list);
    }
    // highest grade first
    for (const list of map.values()) list.sort((a, b) => b.grade - a.grade);
    return map;
  }, [data]);

  const iconsBySlot = useMemo(
    () => Object.fromEntries(SLOTS.map((s) => [s.id, data ? slotIcons(s, data.items) : []])),
    [data],
  );

  const runMatch = useCallback(
    (slot: string, box: Box) => {
      const worker = workerRef.current;
      if (!worker) return;
      const requestId = nextRequestId.current++;
      requestIds.current[slot] = requestId;
      setSlots((s) => ({ ...s, [slot]: { ...s[slot], status: "matching", error: undefined } }));
      const req: WorkerRequest = { type: "match", requestId, slot, box, icons: iconsBySlot[slot], refine: true };
      worker.postMessage(req);
    },
    [iconsBySlot],
  );

  const loadFile = useCallback(async (file: File | null | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const { data: pixels } = ctx.getImageData(0, 0, width, height);

    const url = URL.createObjectURL(file);
    setImage((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { url, width, height };
    });
    // The worker finds the character screen and replies with a layout (see onmessage)
    const id = ++imageId.current;
    const msg: WorkerRequest = { type: "image", imageId: id, pixels, width, height };
    workerRef.current?.postMessage(msg, [pixels.buffer]);

    setLayout(null);
    setBoxes(null);
    setSlots(idleSlots());
  }, []);

  // Match every slot once the layout is known and the data and matcher are ready
  useEffect(() => {
    if (!workerReady || !data || !boxes || !pendingAuto.current) return;
    pendingAuto.current = false;
    for (const s of SLOTS) runMatch(s.id, boxes[s.id]);
  }, [workerReady, data, boxes, runMatch]);

  // Paste from clipboard anywhere on the page
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (file) {
        e.preventDefault();
        loadFile(file);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [loadFile]);

  const busy = Object.values(slots).filter((s) => s.status === "matching").length;
  const status = loadError
    ? loadError
    : !data || !workerReady
      ? "Loading item data…"
      : image && !layout
        ? "Finding the character screen…"
        : busy
        ? `Matching… ${SLOTS.length - busy}/${SLOTS.length} slots done`
        : `${data.items.length.toLocaleString()} items · ${data.icons.length.toLocaleString()} icons loaded`;

  const selectItem = (slot: string, icon: number, itemId?: string) =>
    setSlots((s) => ({ ...s, [slot]: { ...s[slot], icon, itemId } }));

  return (
    <div className={styles.app}>
      <header className={styles.top}>
        <div>
          <h1>TnL Build Reader</h1>
          <p className={styles.sub}>
            Drop a Throne and Liberty character screenshot to identify the equipped weapons, armor and accessories.
          </p>
        </div>
        <span className={`${styles.status} ${loadError ? styles.statusError : ""}`}>{status}</span>
      </header>

      <div
        className={`${styles.drop} ${dragOver ? styles.dropActive : ""} ${image ? styles.dropCompact : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          loadFile(e.dataTransfer.files[0]);
        }}
        onClick={() => fileInput.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInput.current?.click()}
      >
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            loadFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <strong>{image ? "Load another screenshot" : "Drop a screenshot here"}</strong>
        <span>or click to choose a file · or paste with Ctrl+V</span>
      </div>

      {image && !boxes && (
        <div className={`${styles.card} ${styles.pending}`}>
          <div className={styles.spinner} />
          Finding the character screen…
        </div>
      )}

      {image && boxes && (
        <div className={styles.workspace}>
          <div className={styles.overview}>
            <section className={styles.shotPanel}>
              <ScreenshotEditor
                image={image}
                boxes={boxes}
                slots={slots}
                onChange={(id, box) => setBoxes((b) => (b ? { ...b, [id]: box } : b))}
                onCommit={(id, box) => runMatch(id, box)}
              />
              {layout && (
                <div className={`${styles.layoutInfo} ${layout.detected ? "" : styles.layoutWarn}`}>
                  <span>
                    {layout.detected
                      ? `Character screen found: UI at ${Math.round(layout.scale * 100)}% of the reference, offset ${Math.round(layout.tx)}, ${Math.round(layout.ty)} px.`
                      : "Couldn't find the character screen, so the boxes are a best guess. Drag them onto the slots."}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const reset = layoutBoxes(layout);
                      setBoxes(reset);
                      for (const sl of SLOTS) runMatch(sl.id, reset[sl.id]);
                    }}
                  >
                    Reset boxes
                  </button>
                </div>
              )}
              <p className={styles.hint}>
                If a match looks wrong, drag its box over the item icon (or resize it from the corner) and it
                re-matches.
              </p>
            </section>
            {data && <Loadout data={data} stats={stats} slots={slots} itemsByIcon={itemsByIcon} />}
          </div>

          {GROUPS.map((group) => (
            <section key={group} className={styles.group}>
              <h2 className={styles.groupTitle}>{GROUP_LABELS[group]}</h2>
              <div className={styles.results}>
                {SLOTS.filter((s) => s.group === group).map((slot) => (
                  <SlotResult
                    key={slot.id}
                    slot={slot}
                    state={slots[slot.id]}
                    data={data}
                    stats={stats}
                    itemsByIcon={itemsByIcon}
                    onSelect={(icon, itemId) => selectItem(slot.id, icon, itemId)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

const layoutBoxes = (layout: Layout) => Object.fromEntries(SLOTS.map((s) => [s.id, slotBox(s, layout)]));

/** The item currently chosen for a slot, if matched. */
function selectedItem(state: SlotState, itemsByIcon: Map<number, Item[]>): Item | undefined {
  if (state.icon === undefined) return undefined;
  const variants = itemsByIcon.get(state.icon) ?? [];
  return variants.find((i) => i.id === state.itemId) ?? variants[0];
}

function confidence(state: SlotState): "confident" | "close" | "manual" | null {
  const c = state.match?.candidates;
  if (!c?.length || state.icon === undefined) return null;
  if (state.icon !== c[0].icon) return "manual";
  return c.length < 2 || c[0].score - c[1].score >= CONFIDENT_MARGIN ? "confident" : "close";
}

function Loadout({
  data,
  stats,
  slots,
  itemsByIcon,
}: {
  data: ItemData;
  stats: StatFormats;
  slots: Record<string, SlotState>;
  itemsByIcon: Map<number, Item[]>;
}) {
  const [hover, setHover] = useState<{ slot: Slot; item: Item; anchor: DOMRect } | null>(null);
  const show = (slot: Slot, item: Item | undefined) => (e: React.SyntheticEvent<HTMLElement>) =>
    item && setHover({ slot, item, anchor: e.currentTarget.getBoundingClientRect() });
  const hide = () => setHover(null);

  // A hover card is anchored to where the row was; drop it once the page moves
  useEffect(() => {
    if (!hover) return;
    window.addEventListener("scroll", hide, { passive: true });
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide);
      window.removeEventListener("resize", hide);
    };
  }, [hover]);

  return (
    <aside className={styles.loadout}>
      <h2 className={styles.loadoutTitle}>Loadout</h2>
      {GROUPS.map((group) => (
        <div key={group} className={styles.loadoutGroup}>
          <h3>{GROUP_LABELS[group]}</h3>
          <ul>
            {SLOTS.filter((s) => s.group === group).map((slot) => {
              const state = slots[slot.id];
              const item = selectedItem(state, itemsByIcon);
              const conf = confidence(state);
              return (
                <li key={slot.id}>
                  <a
                    href={`#slot-${slot.id}`}
                    className={styles.loadoutRow}
                    onMouseEnter={show(slot, item)}
                    onMouseLeave={hide}
                    onFocus={show(slot, item)}
                    onBlur={hide}
                    onClick={hide}
                  >
                    <span className={styles.loadoutSlot}>{slot.label}</span>
                    {item ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/${data.icons[item.icon]}`}
                          alt=""
                          width={28}
                          height={28}
                          style={{ "--grade": grade(item.grade).color } as React.CSSProperties}
                        />
                        <span className={styles.loadoutName} style={{ color: grade(item.grade).color }}>
                          {item.name}
                        </span>
                        {conf === "close" && (
                          <span className={styles.dotWarn} title="Close call. Check the alternatives" />
                        )}
                      </>
                    ) : (
                      <span className={styles.loadoutPending}>
                        {state.status === "error" ? "failed" : "matching…"}
                      </span>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {hover && (
        <HoverCard anchor={hover.anchor}>
          <ItemTooltip
            key={hover.item.id}
            item={hover.item}
            iconUrl={`/${data.icons[hover.item.icon]}`}
            stats={stats}
            slotLabel={hover.slot.label}
            compact
          />
        </HoverCard>
      )}
    </aside>
  );
}

const HOVER_GAP = 12;
const HOVER_MARGIN = 8;

/**
 * Fixed-position card next to an anchor rect: to its left if there is room (the loadout
 * sits on the right), else to its right, else below; kept inside the viewport vertically.
 */
function HoverCard({ anchor, children }: { anchor: DOMRect; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const clampTop = (t: number) => Math.max(HOVER_MARGIN, Math.min(t, vh - height - HOVER_MARGIN));
    const clampLeft = (l: number) => Math.max(HOVER_MARGIN, Math.min(l, vw - width - HOVER_MARGIN));
    if (anchor.left - HOVER_GAP - width >= HOVER_MARGIN) {
      setPos({ left: anchor.left - HOVER_GAP - width, top: clampTop(anchor.top - 40) });
    } else if (anchor.right + HOVER_GAP + width <= vw - HOVER_MARGIN) {
      setPos({ left: anchor.right + HOVER_GAP, top: clampTop(anchor.top - 40) });
    } else {
      setPos({ left: clampLeft(anchor.left), top: clampTop(anchor.bottom + HOVER_GAP) });
    }
  }, [anchor]);

  // Portalled to <body>: the sticky loadout panel is its own stacking context, so a card
  // rendered inside it would sit under the result tooltips further down the page.
  return createPortal(
    <div
      ref={ref}
      className={styles.hoverCard}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
      role="tooltip"
    >
      {children}
    </div>,
    document.body,
  );
}

function ScreenshotEditor({
  image,
  boxes,
  slots,
  onChange,
  onCommit,
}: {
  image: LoadedImage;
  boxes: Record<string, Box>;
  slots: Record<string, SlotState>;
  onChange: (id: string, box: Box) => void;
  onCommit: (id: string, box: Box) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; mode: "move" | "resize"; startX: number; startY: number; box: Box; last: Box } | null>(
    null,
  );

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;

  const onPointerDown = (e: React.PointerEvent, id: string, mode: "move" | "resize") => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id, mode, startX: e.clientX, startY: e.clientY, box: boxes[id], last: boxes[id] };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !frame.current) return;
    const scale = image.width / frame.current.clientWidth; // screen px -> image px
    const dx = (e.clientX - d.startX) * scale;
    const dy = (e.clientY - d.startY) * scale;
    const b = d.box;
    const next =
      d.mode === "move"
        ? {
            ...b,
            x: Math.min(Math.max(b.x + dx, -b.size / 2), image.width - b.size / 2),
            y: Math.min(Math.max(b.y + dy, -b.size / 2), image.height - b.size / 2),
          }
        : { ...b, size: Math.max(MIN_BOX, b.size + Math.max(dx, dy)) };
    d.last = next;
    onChange(d.id, next);
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && (d.last.x !== d.box.x || d.last.y !== d.box.y || d.last.size !== d.box.size)) onCommit(d.id, d.last);
  };

  return (
    <div
      ref={frame}
      className={styles.frame}
      style={{ aspectRatio: `${image.width} / ${image.height}` }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.url} alt="Uploaded screenshot" draggable={false} />
      {SLOTS.map((slot) => {
        const b = boxes[slot.id];
        const state = slots[slot.id];
        const matched = state.match?.box;
        const conf = confidence(state);
        return (
          <div key={slot.id}>
            {matched && state.status === "done" && (
              <div
                className={styles.matchedArea}
                style={{
                  left: pct(matched.x, image.width),
                  top: pct(matched.y, image.height),
                  width: pct(matched.size, image.width),
                  height: pct(matched.size, image.height),
                }}
              />
            )}
            <div
              className={`${styles.box} ${state.status === "matching" ? styles.boxBusy : ""} ${
                conf === "close" ? styles.boxWarn : ""
              }`}
              style={{
                left: pct(b.x, image.width),
                top: pct(b.y, image.height),
                width: pct(b.size, image.width),
                height: pct(b.size, image.height),
              }}
              title={slot.label}
              onPointerDown={(e) => onPointerDown(e, slot.id, "move")}
            >
              <span className={styles.boxLabel}>{slot.short}</span>
              <span className={styles.handle} onPointerDown={(e) => onPointerDown(e, slot.id, "resize")} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SlotResult({
  slot,
  state,
  data,
  stats,
  itemsByIcon,
  onSelect,
}: {
  slot: Slot;
  state: SlotState;
  data: ItemData | null;
  stats: StatFormats;
  itemsByIcon: Map<number, Item[]>;
  onSelect: (icon: number, itemId?: string) => void;
}) {
  if (!data) return null;
  if (state.status === "error") {
    return (
      <div id={`slot-${slot.id}`} className={styles.card}>
        {slot.label}: matching failed: {state.error}
      </div>
    );
  }
  if (!state.match || state.icon === undefined) {
    return (
      <div id={`slot-${slot.id}`} className={`${styles.card} ${styles.pending}`}>
        <div className={styles.spinner} />
        Matching {slot.label}…
      </div>
    );
  }

  const { candidates } = state.match;
  const variants = itemsByIcon.get(state.icon) ?? [];
  const item = selectedItem(state, itemsByIcon);
  const conf = confidence(state);

  return (
    <div id={`slot-${slot.id}`} className={styles.slotResult}>
      <div className={styles.slotHead}>
        <h2>{slot.label}</h2>
        {state.status === "matching" ? (
          <span className={styles.badge}>re-matching…</span>
        ) : conf === "manual" ? (
          <span className={styles.badge}>Picked manually</span>
        ) : (
          <span className={`${styles.badge} ${conf === "confident" ? styles.good : styles.warn}`}>
            {conf === "confident" ? "Confident match" : "Close call. Check the alternatives"}
          </span>
        )}
      </div>

      {item && (
        <ItemTooltip
          key={item.id}
          item={item}
          iconUrl={`/${data.icons[item.icon]}`}
          stats={stats}
          slotLabel={slot.label}
        />
      )}

      {variants.length > 1 && (
        <label className={styles.variant}>
          This icon is used by {variants.length} items:{" "}
          <select value={item?.id} onChange={(e) => onSelect(state.icon!, e.target.value)}>
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({grade(v.grade).name})
              </option>
            ))}
          </select>
        </label>
      )}

      <div className={styles.candidates}>
        <span className={styles.candLabel}>Other matches</span>
        <div className={styles.candList}>
          {candidates.map((c) => {
            const top = itemsByIcon.get(c.icon)?.[0];
            if (!top) return null;
            return (
              <button
                key={c.icon}
                className={`${styles.cand} ${c.icon === state.icon ? styles.candActive : ""}`}
                style={{ "--grade": grade(top.grade).color } as React.CSSProperties}
                onClick={() => onSelect(c.icon)}
                title={`${top.name}, score ${c.score.toFixed(3)}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/${data.icons[c.icon]}`} alt={top.name} width={48} height={48} />
                <span>{c.score.toFixed(2)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
