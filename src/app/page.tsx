import type { Metadata } from "next";
import Link from "next/link";

import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";

export const metadata: Metadata = {
  title: "Projects",
};

const projects = [
  {
    href: "/dragon-fractal",
    title: "Dragon fractal",
    description: "Shader zoom of the curly dragon.",
  },
  {
    href: "/dragon-ascii",
    title: "Dragon ASCII",
    description: "The same dragon, drawn with ASCII glyphs.",
  },
];

export default function Home() {
  return (
    <main className="flex min-h-full flex-1 bg-muted/50">
      <div className="mx-auto flex w-full max-w-lg flex-col gap-6 p-6">
        <h1 className="text-2xl font-semibold">Projects</h1>
        <ItemGroup>
          {projects.map((project) => (
            <Item
              key={project.href}
              variant="outline"
              className="bg-card"
              render={<Link href={project.href} />}
            >
              <ItemContent>
                <ItemTitle>{project.title}</ItemTitle>
                <ItemDescription>{project.description}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </div>
    </main>
  );
}
