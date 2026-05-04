import crypto from "node:crypto";
import path from "node:path";
import { readJson, writeJson } from "./json-store.ts";

const TEST_ID = "lp_visual";
const MIN_VIEWS_TO_PICK_WINNER = 100;

export type AbVariant = {
  id: string;
  label: string;
  weight: number;
  image: string;
  ogImage: string;
};

type AbStats = { views: number; conversions: number };
type AbState = { tests: Record<string, { variants: Record<string, AbStats> }> };

const DEFAULT_VARIANTS: AbVariant[] = [
  {
    id: "dog-figure",
    label: "キャラクター画像",
    weight: 1,
    image: "/assets/lp/accent-dog.jpg",
    ogImage: "/og-image-dog.svg",
  },
  {
    id: "stair-illustration",
    label: "階段イラスト",
    weight: 1,
    image: "/assets/lp/stair-illustration.png",
    ogImage: "/og-image-stair.svg",
  },
];

export class AbService {
  file: string;

  constructor({ dataDir }: { dataDir: string }) {
    this.file = path.join(dataDir, "ab-tests.json");
  }

  async chooseVariant(cookies: Record<string, string> = {}) {
    const state = await this.readState();
    const winner = this.pickWinner(state);
    const cookieVariant = DEFAULT_VARIANTS.find((variant) => variant.id === cookies.ab_lp_visual);
    const variant = winner || cookieVariant || this.weightedRandomVariant();
    await this.increment(variant.id, "views");
    return { variant, shouldSetCookie: !cookieVariant || cookieVariant.id !== variant.id };
  }

  async recordConversion(variantId: string) {
    const variant = DEFAULT_VARIANTS.find((item) => item.id === variantId);
    if (!variant) return { ok: false };
    await this.increment(variant.id, "conversions");
    return { ok: true };
  }

  async summary() {
    const state = await this.readState();
    const variants = DEFAULT_VARIANTS.map((variant) => {
      const stats = state.tests[TEST_ID]?.variants?.[variant.id] || { views: 0, conversions: 0 };
      const conversionRate = stats.views > 0 ? stats.conversions / stats.views : 0;
      return { ...variant, ...stats, conversionRate };
    });
    return { testId: TEST_ID, winner: this.pickWinner(state), variants };
  }

  async readState(): Promise<AbState> {
    const fallback: AbState = { tests: { [TEST_ID]: { variants: {} } } };
    const state = await readJson<AbState>(this.file, fallback);
    state.tests ||= {};
    state.tests[TEST_ID] ||= { variants: {} };
    return state;
  }

  async increment(variantId: string, metric: keyof AbStats) {
    const state = await this.readState();
    const variants = state.tests[TEST_ID].variants;
    variants[variantId] ||= { views: 0, conversions: 0 };
    variants[variantId][metric] = (variants[variantId][metric] || 0) + 1;
    await writeJson(this.file, state);
  }

  pickWinner(state: AbState) {
    const variants = DEFAULT_VARIANTS.map((variant) => {
      const stats = state.tests[TEST_ID]?.variants?.[variant.id] || { views: 0, conversions: 0 };
      return { ...variant, ...stats, conversionRate: stats.views > 0 ? stats.conversions / stats.views : 0 };
    });
    const totalViews = variants.reduce((sum, variant) => sum + variant.views, 0);
    if (totalViews < MIN_VIEWS_TO_PICK_WINNER) return null;
    return variants.sort((a, b) => b.conversionRate - a.conversionRate || b.conversions - a.conversions)[0];
  }

  weightedRandomVariant() {
    const total = DEFAULT_VARIANTS.reduce((sum, variant) => sum + variant.weight, 0);
    let cursor = crypto.randomInt(1, total + 1);
    for (const variant of DEFAULT_VARIANTS) {
      cursor -= variant.weight;
      if (cursor <= 0) return variant;
    }
    return DEFAULT_VARIANTS[0];
  }
}
