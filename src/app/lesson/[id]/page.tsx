import type { Metadata } from "next";
import { Suspense } from "react";
import { Workspace, WorkspaceSkeleton } from "@/components/tutor/Workspace";

export const metadata: Metadata = { title: "Lesson" };

export default function LessonPage(props: PageProps<"/lesson/[id]">) {
  // `params` is request-time data, so it is awaited inside a Suspense boundary (Cache Components).
  return (
    <Suspense fallback={<WorkspaceSkeleton />}>
      <LessonLoader params={props.params} />
    </Suspense>
  );
}

async function LessonLoader({ params }: Pick<PageProps<"/lesson/[id]">, "params">) {
  const { id } = await params;
  // `key` gives every lesson a fresh workspace (and player) when navigating between lessons.
  return <Workspace key={id} lessonId={id} />;
}
