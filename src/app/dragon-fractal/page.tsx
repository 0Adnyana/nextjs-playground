import type { Metadata } from "next";

import { BackHome } from "@/components/back-home";

import { DragonFractal } from "./player";

export const metadata: Metadata = {
  title: "Dragon fractal",
};

export default function Page() {
  return (
    <>
      <DragonFractal />
      <BackHome />
    </>
  );
}
