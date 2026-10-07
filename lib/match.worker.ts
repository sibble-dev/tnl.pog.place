// Runs the icon matcher off the main thread.
import { detectLayout, parseLayoutTemplate, type Layout, type LayoutTemplate } from "./layout";
import { matchSlot, parseFeatures, type Box, type FeatureSet, type SlotMatch } from "./matcher";

export type WorkerRequest =
  | { type: "init"; features: ArrayBuffer; n: number; layout: ArrayBuffer }
  | { type: "image"; imageId: number; pixels: Uint8ClampedArray; width: number; height: number }
  | { type: "match"; requestId: number; slot: string; box: Box; icons: number[]; refine: boolean };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "layout"; imageId: number; layout: Layout }
  | { type: "result"; requestId: number; slot: string; match: SlotMatch }
  | { type: "error"; requestId?: number; message: string };

let features: FeatureSet | null = null;
let layoutTemplate: LayoutTemplate | null = null;
let image: { id: number; pixels: Uint8ClampedArray; width: number; height: number } | null = null;

// Layout needs the template; an image that arrives before init is handled when it lands
const postLayout = () => {
  if (!image || !layoutTemplate) return;
  const layout = detectLayout(image.pixels, image.width, image.height, layoutTemplate);
  post({ type: "layout", imageId: image.id, layout });
};

const post = (msg: WorkerResponse) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      features = parseFeatures(msg.features, msg.n);
      layoutTemplate = parseLayoutTemplate(msg.layout);
      postLayout();
      post({ type: "ready" });
    } else if (msg.type === "image") {
      image = { id: msg.imageId, pixels: msg.pixels, width: msg.width, height: msg.height };
      postLayout();
    } else if (msg.type === "match") {
      if (!features || !image) throw new Error("Matcher not ready");
      const match = matchSlot(image.pixels, image.width, image.height, msg.box, features, {
        icons: msg.icons,
        refine: msg.refine,
      });
      post({ type: "result", requestId: msg.requestId, slot: msg.slot, match });
    }
  } catch (err) {
    post({
      type: "error",
      requestId: msg.type === "match" ? msg.requestId : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
