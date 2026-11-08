import type { Metadata } from "next";
import { DragonFractal } from "../dragon-fractal/player";

export const metadata: Metadata = {
  title: "Dragon ASCII",
};

// Dark ink picks a mark near the start. Light ink picks one near the end.
const GLYPHS = " .:-=+*#%@";

export default function Page() {
  return <DragonFractal glyphs={GLYPHS} />;
}
