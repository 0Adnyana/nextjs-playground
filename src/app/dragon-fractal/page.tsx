import type { Metadata } from "next";
import { DragonFractal } from "./player";

export const metadata: Metadata = {
  title: "Dragon fractal",
};

export default function Page() {
  return <DragonFractal />;
}
