import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "cn";

export function BackHome() {
  return (
    <Link
      href="/"
      className={cn(
        buttonVariants({ variant: "outline" }),
        "fixed top-[max(1rem,env(safe-area-inset-top))] left-[max(1rem,env(safe-area-inset-left))] z-20 h-11 gap-2 rounded-full bg-background/90 px-4 shadow-lg backdrop-blur-md",
      )}
    >
      <ArrowLeft aria-hidden="true" />
      Back
    </Link>
  );
}
